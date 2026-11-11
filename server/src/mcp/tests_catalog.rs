//! The tool catalog as a contract: what each kind of caller is offered, that every tool answers
//! cleanly whatever it is sent, that no tool reads another account's rows, and that the public
//! guide lists the same tools.
//!
//! The golden files are in `snapshots/`. A meant change is recorded by running the tests with
//! `YAMA_UPDATE_SNAPSHOTS=1` and committing the files; the diff is then the review of what
//! connected clients will see change.

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
        ("OAuth sign-in limited to reading and staging, power user", who(true), Via::OAuthLimited(crate::oauth::Access::Stage)),
        ("OAuth sign-in limited to reading, power user", who(true), Via::OAuthLimited(crate::oauth::Access::Read)),
    ]
}

fn repo_file(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(path)
}

/// Compare with a golden file, or write it when `YAMA_UPDATE_SNAPSHOTS` is set.
fn assert_snapshot(name: &str, actual: &str) {
    let path = repo_file("src/mcp/snapshots").join(name);
    if std::env::var_os("YAMA_UPDATE_SNAPSHOTS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap_or_default();
    if expected == actual {
        return;
    }
    let (old, new): (Vec<&str>, Vec<&str>) = (expected.lines().collect(), actual.lines().collect());
    let at = old.iter().zip(&new).position(|(a, b)| a != b).unwrap_or(old.len().min(new.len()));
    panic!(
        "The tool catalog changed ({name}, first at line {}).\n  was: {}\n  now: {}\n\
         If the change is meant, run the tests with YAMA_UPDATE_SNAPSHOTS=1 and commit server/src/mcp/snapshots/{name}. \
         Connected clients see this change: keep every old tool and parameter name working, and update the public guide \
         (web/public/docs/mcp/index.html), the advisor's tool names (web/src/advisor/logic.ts), the prompts \
         (server/src/mcp/workflows.rs) and the plugin skills (plugins/) with it.",
        at + 1,
        old.get(at).unwrap_or(&"(nothing)"),
        new.get(at).unwrap_or(&"(nothing)"),
    );
}

fn names(tools: &[Value]) -> Vec<&str> {
    tools.iter().map(|t| t["name"].as_str().unwrap()).collect()
}

#[test]
fn tools_list_matches_its_snapshot_for_every_kind_of_caller() {
    // The fullest list, whole: names, titles, descriptions, schemas and annotations.
    let full = tools::list(&who(true), &Via::Key);
    let mut text = serde_json::to_string_pretty(&json!({"tools": full})).unwrap();
    text.push('\n');
    assert_snapshot("tools_list.json", &text);

    // Every other caller gets tools from that list, unchanged; the snapshot says which.
    let mut by_caller = String::new();
    for (label, user, via) in callers() {
        let tools = tools::list(&user, &via);
        by_caller.push_str(&format!("## {label}: {} tools\n", tools.len()));
        for t in &tools {
            let same = full.iter().find(|f| f["name"] == t["name"]);
            assert_eq!(same, Some(t), "{label} gets a different {} than the full list has", t["name"]);
            let does = match (t["annotations"]["readOnlyHint"].as_bool(), t["annotations"]["destructiveHint"].as_bool()) {
                (Some(true), _) => "read",
                (_, Some(true)) => "destructive",
                _ => "write",
            };
            let outside = if t["annotations"]["openWorldHint"] == true { ", reaches outside Yama" } else { "" };
            by_caller.push_str(&format!("{}\t{does}{outside}\n", t["name"].as_str().unwrap()));
        }
        by_caller.push('\n');
    }
    // An account that has no stores, datasets or lab runs is listed fewer tools.
    let new = super::registry::list_for(&who(false), &Via::Key, super::registry::Has::NOTHING);
    by_caller.push_str(&format!("## script key, an account with no stores, datasets or lab runs: {} tools\n", new.len()));
    for t in &new {
        by_caller.push_str(&format!("{}\n", t["name"].as_str().unwrap()));
    }
    assert_snapshot("tools_by_caller.txt", &by_caller);
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
        let simulates = ["start_lab_run", "add_lab_games", "rerun_lab_run"].iter().any(|n| names.contains(n));
        assert_eq!(simulates, user.power && via.may_stage(), "{label}: only power users start simulations");
        // A read-only connection is offered nothing that writes.
        let writes = tools.iter().any(|t| t["annotations"]["readOnlyHint"] == false);
        assert_eq!(writes, via.may_stage(), "{label}");
        assert!(names.contains(&"get_overview") && names.contains(&"search_cards"), "{label} reads");
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
    assert!(!outside("list_card_printings"));
    // check_stores only stages, but applying it reads the stores' sites.
    assert!(outside("check_stores"));
    for reaches in ["search_scryfall", "get_commander_recommendations", "search_combos", "get_public_deck", "search_rules"] {
        assert!(outside(reaches), "{reaches}");
    }
    for local in ["search_cards", "get_cards", "get_deck", "get_deck_analysis", "edit_deck", "apply_change", "save_research", "get_store_stock"] {
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
    let (has_all, empty) = power_user(&pool, "empty@example.com").await;
    // Listed everything: an account with a store and a dataset, that may run the lab.
    sqlx::query("INSERT INTO plan_stores (id, owner_id, key, name, kind, origin, created_at, updated_at) VALUES ('store-all', ?, 'a-store', 'A Store', 'local', 'yama', 't', 't')").bind(&has_all).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO evidence_datasets (id, owner_id, external_id) VALUES ('dataset-all', ?, 'a-dataset')").bind(&has_all).execute(&pool).await.unwrap();
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
    assert!(err && text.contains("isn't name, mv, edhrec, color, usd, usd_asc, released or released_asc"), "{text}");
    for order in ["name", "mv", "cmc", "edhrec", "color", "usd", "usd_asc", "released", "released_asc"] {
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
    assert!(err && text == "cards: each one is at most 300 characters", "a refusal names the argument the schema lists: {text}");
    let (err, text) = clean_call(&app, &plain, "games", json!({"search": "z".repeat(1001)})).await;
    assert!(err && text == "query is too long: at most 1000 characters", "{text}");
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
const OWNED: [&str; 16] = ["id", "run_id", "deck", "plan", "key", "store", "stores", "container", "from", "to", "other", "entrants", "left", "right", "wish", "playgroup"];

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
        ("update_deck", json!({"deck": deck, "bracket": 3}), Works),
        // The owner's side, with a real wish, is in tests.rs (wishes_containers_and_copies_change_only_when_applied).
        ("remove_wish", json!({"wish": "want-a"}), Unchecked),
        ("edit_copies", json!({"card": "Sol Ring", "container": "Box A", "proxy": true}), Works),
        ("remove_from_collection", json!({"card": "Sol Ring", "from": "Box A"}), Works),
        ("list_games", json!({"playgroup": "group-a"}), Works),
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
    // The cases call tools by the names they had before the renames; that is the aliases' test.
    let covered: BTreeSet<&str> = cases.iter().map(|c| c.0).chain(ISOLATION_ELSEWHERE.iter().map(|e| e.0)).map(|name| super::registry::find(name).expect("a tool or an older name of one").name).collect();
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

// ── the renames (2026-11-11) ────────────────────────────────────────────────

/// Connected clients must not have to reconnect: a client that still has the old list calls the
/// old names with the old arguments, and gets what it always got.
#[tokio::test]
async fn old_tool_names_and_old_argument_names_still_work() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (owner, session) = power_user(&pool, "owner@example.com").await;
    let mcp = key(&app, &session, Some("mcp")).await;
    one_of_everything(&app, &pool, &owner, &mcp).await;
    // With a dataset as well, the account is listed every tool.
    sqlx::query("INSERT INTO evidence_datasets (id, owner_id, external_id) VALUES ('dataset-a', ?, 'a-dataset')").bind(&owner).execute(&pool).await.unwrap();
    let tools = listed(&app, &mcp).await;
    let listed_names = names(&tools);

    // Every older name answers as the tool it became, and none is listed.
    let mut older = 0;
    for t in super::registry::all() {
        for alias in t.aliases {
            older += 1;
            assert!(!listed_names.contains(alias), "{alias} is an older name and shouldn't be listed");
            assert!(listed_names.contains(&t.name), "{} isn't listed", t.name);
            let (old_err, old_text) = clean_call(&app, &mcp, alias, json!({})).await;
            let (new_err, new_text) = clean_call(&app, &mcp, t.name, json!({})).await;
            assert_eq!(old_err, new_err, "{alias} and {} disagree", t.name);
            if old_err {
                assert_eq!(old_text, new_text, "{alias} and {} refuse differently", t.name);
            }
        }
    }
    assert_eq!(older, 37, "the renamed tools");
}

#[tokio::test]
async fn renamed_arguments_work_under_either_name() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (owner, session) = power_user(&pool, "owner@example.com").await;
    let mcp = key(&app, &session, Some("mcp")).await;
    one_of_everything(&app, &pool, &owner, &mcp).await;
    let tools = listed(&app, &mcp).await;
    let schema = |name: &str| tools.iter().find(|t| t["name"] == name).unwrap()["inputSchema"].clone();

    // The list shows the new name only, required where the old one was.
    let run = schema("get_lab_run");
    assert!(run["properties"]["run_id"].is_object() && run["properties"].get("id").is_none(), "{run}");
    assert_eq!(run["required"], json!(["run_id"]));
    assert!(schema("get_plan")["properties"]["plan"].is_object() && schema("get_shopping_trip")["properties"]["as_of"].is_object());
    assert!(schema("list_games")["properties"]["query"].is_object() && schema("get_cards")["properties"]["cards"].is_object());
    assert!(schema("propose_swap")["properties"]["reason"].is_object() && schema("propose_swap")["properties"].get("why").is_none());
    // A renamed argument keeps the length it could always be.
    assert_eq!(schema("propose_swap")["properties"]["reason"]["maxLength"], 2000);
    assert_eq!(schema("edit_deck")["properties"]["reason"]["maxLength"], 6000);

    // Old tool with its old argument, new tool with its new one: the same answer.
    for (old, old_args, new, new_args) in [
        ("card", json!({"names": ["Sol Ring"]}), "get_cards", json!({"cards": ["Sol Ring"]})),
        ("games", json!({"search": "SECRET"}), "list_games", json!({"query": "SECRET"})),
        ("shopping_list", json!({"today": "2026-11-01"}), "get_shopping_list", json!({"as_of": "2026-11-01"})),
        ("card_printings", json!({"name": "Sol Ring"}), "list_card_printings", json!({"card": "Sol Ring"})),
    ] {
        let (old_err, old_text) = clean_call(&app, &mcp, old, old_args.clone()).await;
        let (new_err, new_text) = clean_call(&app, &mcp, new, new_args.clone()).await;
        assert!(!old_err && !new_err, "{old} {old_args}: {old_text}\n{new} {new_args}: {new_text}");
        assert_eq!(old_text, new_text, "{old} and {new}");
        // The new tool also takes the old argument, and the old tool the new one.
        let (err, text) = clean_call(&app, &mcp, new, old_args).await;
        assert!(!err && text == new_text, "{new} with the old argument: {text}");
        let (err, text) = clean_call(&app, &mcp, old, new_args).await;
        assert!(!err && text == new_text, "{old} with the new argument: {text}");
    }
    let (err, text) = clean_call(&app, &mcp, "list_games", json!({"query": "SECRET"})).await;
    assert!(!err && text.contains("SECRET Kelly"), "{text}");

    // A refusal names the argument the schema lists, whichever name the handler reads.
    for (tool, args, says) in [
        ("get_lab_run", json!({}), "run_id is missing"),
        ("lab_run", json!({}), "run_id is missing"),
        ("get_plan", json!({}), "plan is missing"),
        ("get_shopping_trip", json!({"as_of": "soon"}), "as_of: \"soon\" isn't a YYYY-MM-DD date"),
        ("get_cards", json!({}), "cards is missing"),
        ("propose_swap", json!({"plan": "plan-a", "card_in": "Sol Ring", "why": "a", "reason": "b"}), "why is the older name of reason: give only reason"),
    ] {
        let (err, text) = clean_call(&app, &mcp, tool, args.clone()).await;
        assert!(err && text == says, "{tool} {args}: {text}");
    }

    // One op id is one request, under either name of an argument.
    let op = "5d2b9a52-1f1e-4d3c-9a56-0f2d8c1b7e11";
    let (err, first) = clean_call(&app, &mcp, "propose_swap", json!({"plan": "plan-a", "card_in": "Sol Ring", "why": "It ramps.", "op_id": op})).await;
    assert!(!err && first.starts_with("Staged for their review"), "{first}");
    let (err, again) = clean_call(&app, &mcp, "propose_swap", json!({"plan": "plan-a", "card_in": "Sol Ring", "reason": "It ramps.", "op_id": op})).await;
    assert!(!err && again.starts_with("Already staged with this op_id"), "{again}");
    // What is stored keeps the names it always had: the change kind and its payload.
    let (kind, payload): (String, String) = sqlx::query_as("SELECT kind, payload FROM assistant_changes WHERE owner_id = ? AND op_id = ?").bind(&owner).bind(op).fetch_one(&pool).await.unwrap();
    assert_eq!(kind, "propose_swap");
    assert_eq!(serde_json::from_str::<Value>(&payload).unwrap()["why"], "It ramps.");
}

// ── for anyone's account (2026-11-11) ───────────────────────────────────────

#[tokio::test]
async fn an_account_is_listed_the_tools_it_can_use() {
    let (app, pool) = app().await;
    let (id, session) = user(&pool, "new@example.com").await;
    let (_, other_session) = user(&pool, "other@example.com").await;
    let mcp = key(&app, &session, Some("mcp")).await;
    let other = key(&app, &other_session, Some("mcp")).await;
    let stores = ["get_shopping_trip", "get_shopping_settings", "set_shopping_rules", "set_store_preference", "get_store_stock", "check_stores"];
    let datasets = ["list_datasets", "get_dataset"];
    let lab_reads = ["list_lab_runs", "get_lab_run", "list_lab_games", "cancel_lab_run"];
    let lab_starts = ["start_lab_run", "add_lab_games", "rerun_lab_run"];
    async fn has(app: &axum::Router, token: &str, names: &[&str]) -> Vec<bool> {
        let tools = listed(app, token).await;
        names.iter().map(|n| tools.iter().any(|t| t["name"] == *n)).collect()
    }
    let none = |v: Vec<bool>| v.iter().all(|x| !x);
    let all = |v: Vec<bool>| v.iter().all(|x| *x);

    // A new account: its decks, cards, collection, games and notes, and nothing it can't use.
    assert!(all(has(&app, &mcp, &["get_overview", "get_deck", "search_cards", "edit_deck", "save_deck", "add_wish", "get_shopping_list", "list_games", "save_research"]).await));
    assert!(none(has(&app, &mcp, &stores).await) && none(has(&app, &mcp, &datasets).await) && none(has(&app, &mcp, &lab_reads).await) && none(has(&app, &mcp, &lab_starts).await));
    // A client with an older list may still call one: it is told what there is, which is nothing.
    let (_, text) = clean_call(&app, &mcp, "get_shopping_settings", json!({})).await;
    assert!(!text.is_empty());

    // Each appears with the thing it works on, for that account only.
    sqlx::query("INSERT INTO plan_stores (id, owner_id, key, name, kind, origin, created_at, updated_at) VALUES ('s1', ?, 'a-store', 'A Store', 'local', 'yama', 't', 't')").bind(&id).execute(&pool).await.unwrap();
    assert!(all(has(&app, &mcp, &stores).await) && none(has(&app, &mcp, &datasets).await));
    sqlx::query("UPDATE plan_stores SET retired_at = 't' WHERE id = 's1'").execute(&pool).await.unwrap();
    assert!(none(has(&app, &mcp, &stores).await), "a retired store isn't one of their stores");
    sqlx::query("UPDATE plan_stores SET retired_at = NULL WHERE id = 's1'").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO evidence_datasets (id, owner_id, external_id) VALUES ('d1', ?, 'a-dataset')").bind(&id).execute(&pool).await.unwrap();
    assert!(all(has(&app, &mcp, &datasets).await));
    sqlx::query(
        "INSERT INTO lab_experiments (id, owner_id, name, status, spec, games_total, games_done, engine, card_data, runner, difficulty, created_at, updated_at)
         VALUES ('run-1', ?, 'An old run', 'done', '{}', 100, 100, 'phase', 'x', 'x', 'Easy', '2026-11-01T00:00:00Z', 't')",
    )
    .bind(&id)
    .execute(&pool)
    .await
    .unwrap();
    assert!(all(has(&app, &mcp, &lab_reads).await) && none(has(&app, &mcp, &lab_starts).await), "their own runs to read, none to start");
    sqlx::query("UPDATE users SET power_user = 1 WHERE id = ?").bind(&id).execute(&pool).await.unwrap();
    assert!(all(has(&app, &mcp, &lab_starts).await));
    assert!(none(has(&app, &other, &stores).await) && none(has(&app, &other, &datasets).await) && none(has(&app, &other, &lab_reads).await), "another account's rows don't count");
}

#[test]
fn descriptions_are_short_and_written_for_anyone() {
    let full = tools::list(&who(true), &Via::Key);
    let mut total = 0;
    // Words that describe one person's setup: his stores, his plan files, his deck-building scheme.
    let his = ["Pat's", "Mothership", "Black Castle", "Multiverse", "Austin", "swap bag", "plan file", "Bracket 4 build", "commander-decks", "Admins also"];
    for t in &full {
        let (name, description) = (t["name"].as_str().unwrap(), t["description"].as_str().unwrap());
        let length = description.chars().count();
        total += length;
        assert!(length <= 650, "{name}'s description is {length} characters; say what it is for, and put the rest in docs/mcp-tool-notes.md");
        for word in his {
            assert!(!description.contains(word), "{name}'s description says {word:?}");
        }
        let schema = t["inputSchema"].to_string();
        for word in his {
            assert!(!schema.contains(word), "{name}'s arguments say {word:?}");
        }
    }
    assert!(total <= 25_000, "the descriptions are {total} characters in all");
    let instructions = super::SERVER_INSTRUCTIONS;
    assert!(instructions.chars().count() <= 2_600, "the instructions are {} characters", instructions.chars().count());
    for word in his {
        assert!(!instructions.contains(word), "the instructions say {word:?}");
    }
    // Every tool the instructions name is a tool.
    for named in instructions.split('`').skip(1).step_by(2) {
        assert!(full.iter().any(|t| t["name"] == named), "the instructions name `{named}`, which isn't a tool");
    }
}

/// A document the server embeds must be copied into the image build, or the release won't compile.
#[test]
fn embedded_documents_are_in_the_image_build() {
    let source = include_str!("workflows.rs");
    let dockerfile = std::fs::read_to_string(repo_file("../deploy/Dockerfile")).unwrap();
    let mut embedded = 0;
    for path in source.split("include_str!(\"../../../").skip(1).map(|rest| rest.split('"').next().unwrap()) {
        embedded += 1;
        assert!(dockerfile.contains(&format!("COPY {path} {path}")), "deploy/Dockerfile doesn't copy {path}, which the server embeds");
    }
    assert!(embedded >= 3, "{embedded} embedded documents");
}
