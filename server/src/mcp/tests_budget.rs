//! Answers stay small on a large account. A client rejects a tool answer above its size limit
//! (Bryan's `overview` was 62,304 characters, 11 Nov 2026), so a default answer has a budget and
//! the rest is reached by asking for it.

use super::tests::{call, key, rpc, seed_cards};
use crate::decks::{Board, DeckCard};
use crate::testutil::{app, power_user, send};
use axum::http::Method;
use serde_json::{Value, json};
use sqlx::SqlitePool;

/// The most characters a tool may answer with when nothing asks it for more.
const DEFAULT_BUDGET: usize = 20_000;
/// `overview` is the first call of every conversation: it gets less.
const OVERVIEW_BUDGET: usize = 8_000;

const DECKS: usize = 40;
const PLANS: usize = 30;
const NOTES: usize = 12;
/// One more note, as wide as a collection-wide audit: its decks alone must not fill an answer.
const WIDE_NOTE_DECKS: usize = 60;
const NOTE_DECKS: usize = NOTES * 4 + WIDE_NOTE_DECKS;

fn deck_name(i: usize) -> String {
    format!("Deck {i:03}, with the kind of long name people give a deck")
}

/// An account bigger than Bryan's: decks with configurations, plans with proposals, notes with
/// many builds, games, lab runs, staged changes, containers and playgroups. Ids are the length
/// real ones are and the optional fields are filled in, so a row weighs what a real row weighs.
async fn large_account(pool: &SqlitePool, owner: &str) {
    let cards = || {
        vec![
            DeckCard { oracle_id: "o-cmd".into(), name: "Test Commander".into(), qty: 1, board: Board::Commander },
            DeckCard { oracle_id: "o-sol".into(), name: "Sol Ring".into(), qty: 1, board: Board::Main },
        ]
    };
    for i in 0..DECKS {
        let main = crate::decks::create_deck_with_cards(pool, owner, &deck_name(i), None, cards()).await.unwrap();
        for label in ["stock", "after prints"] {
            let id = crate::decks::create_deck_with_cards(pool, owner, &format!("{} ({label})", deck_name(i)), None, cards()).await.unwrap();
            sqlx::query("UPDATE decks SET parent_id = ?, configuration = ? WHERE id = ?").bind(&main).bind(label).bind(&id).execute(pool).await.unwrap();
        }
    }
    let why = "It draws two cards a turn once the engine is online, and the deck has no other way to refill its hand after a board wipe. ".repeat(2);
    for i in 0..PLANS {
        let id = format!("plan-{i:03}");
        sqlx::query(
            "INSERT INTO plan_decks (id, owner_id, key, name, source, status, commander, sort, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'import', ?, '[\"Test Commander\"]', ?, 't', 't')",
        )
        .bind(&id)
        .bind(owner)
        .bind(&id)
        .bind(format!("Plan {i:03}, with a long name too"))
        .bind(if i < 25 { "active" } else { "archived" })
        .bind(i as i64)
        .execute(pool)
        .await
        .unwrap();
        for j in 0..12 {
            sqlx::query(
                "INSERT INTO plan_swaps (id, owner_id, plan_deck_id, ext_key, stage, role, src, out_name, in_name, why, why_out, sort, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 'proposed', 'swap', 'buy', ?, ?, ?, ?, ?, 't', 't')",
            )
            .bind(format!("swap-{i}-{j}"))
            .bind(owner)
            .bind(&id)
            .bind(format!("key-{i}-{j}"))
            .bind(format!("Card out {j}"))
            .bind(format!("Card in {j}"))
            .bind(&why)
            .bind(&why)
            .bind(j as i64)
            .execute(pool)
            .await
            .unwrap();
        }
    }
    for n in 0..NOTES {
        let decks: Vec<Value> = (0..4)
            .map(|d| {
                let builds: Vec<Value> = (2..=5)
                    .map(|b| json!({"id": format!("b{b}"), "label": format!("Bracket {b} build with a label"), "bracket": b, "list": "Commander\n1 Saheeli\nDeck\n99 Island"}))
                    .collect();
                json!({"key": format!("deck-{n}-{d}"), "name": format!("Note deck {n}-{d} with a long name"), "commander": "Saheeli", "recommended_build": "b3", "builds": builds})
            })
            .collect();
        let doc = json!({"schema": "yama-research/1", "id": format!("note-{n:02}"), "title": format!("Research note {n:02} with a long title"), "generated_at": "2026-11-01T00:00:00Z", "decks": decks});
        crate::deck_research::save(pool, owner, &doc).await.unwrap();
    }
    let wide: Vec<Value> = (0..WIDE_NOTE_DECKS)
        .map(|d| {
            let builds: Vec<Value> = (1..=6)
                .map(|b| json!({"id": format!("b{b}"), "label": format!("Bracket {} build with a label", b.min(5)), "bracket": b.min(5), "list": "Commander\n1 Saheeli\nDeck\n99 Island"}))
                .collect();
            json!({"key": format!("wide-{d:02}"), "name": format!("Wide note deck {d:02} with a long name"), "commander": "Saheeli", "recommended_build": "b3", "builds": builds})
        })
        .collect();
    let doc = json!({"schema": "yama-research/1", "id": "note-wide", "title": "A collection-wide audit with a long title", "generated_at": "2026-11-01T00:00:00Z", "decks": wide});
    crate::deck_research::save(pool, owner, &doc).await.unwrap();
    for g in 0..120 {
        let id = crate::util::new_id();
        sqlx::query(
            "INSERT INTO games (id, mode, created_by, status, started_at, ended_at, turns, winner_seat, first_seat, win_condition, note)
             VALUES (?, 'in_person', ?, 'finished', ?, ?, 9, 0, 1, 'commander_damage', 'A long game with a note about how it went and who did what')",
        )
        .bind(&id)
        .bind(owner)
        .bind(format!("2026-10-{:02}T20:{:02}:00Z", g % 28 + 1, g % 60))
        .bind(format!("2026-10-{:02}T22:{:02}:00Z", g % 28 + 1, g % 60))
        .execute(pool)
        .await
        .unwrap();
        for seat in 0..4 {
            sqlx::query(
                "INSERT INTO game_seats (game_id, seat, guest_name, commander_name, deck_label, final_life, eliminated_turn, eliminated_by_seat, fun)
                 VALUES (?, ?, ?, 'Atraxa, Praetors'' Voice', 'A precon with a long label', ?, ?, ?, 4)",
            )
            .bind(&id)
            .bind(seat)
            .bind(format!("Player with a long name {seat}"))
            .bind(if seat == 0 { 12 } else { 0 })
            .bind((seat != 0).then_some(7 + seat))
            .bind((seat != 0).then_some(0))
            .execute(pool)
            .await
            .unwrap();
        }
    }
    for e in 0..40 {
        sqlx::query(
            "INSERT INTO lab_experiments (id, owner_id, name, status, spec, games_total, games_done, engine, card_data, runner, difficulty, created_at, updated_at)
             VALUES (?, ?, ?, 'done', '{}', 100, 100, 'phase', 'x', 'x', 'Easy', ?, 't')",
        )
        .bind(format!("run-{e:03}"))
        .bind(owner)
        .bind(format!("Experiment {e:03}: {}", "a change with a long name ".repeat(8)))
        .bind(format!("2026-11-{:02}T00:00:00Z", e % 28 + 1))
        .execute(pool)
        .await
        .unwrap();
    }
    for c in 0..super::changes::MAX_PENDING {
        sqlx::query("INSERT INTO assistant_changes (id, owner_id, kind, summary, payload, via, created_at) VALUES (?, ?, 'add_wish', ?, '{}', 'key', '2026-11-01T00:00:00Z')")
            .bind(format!("change-{c:03}"))
            .bind(owner)
            .bind(format!("Deck {c}: {}", "+A card with a long name, ".repeat(40)))
            .execute(pool)
            .await
            .unwrap();
    }
    for b in 0..30 {
        let id = crate::util::new_id();
        sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at) VALUES (?, ?, 'binder', ?, 't')")
            .bind(&id)
            .bind(owner)
            .bind(format!("Binder {b:02} with a long descriptive name"))
            .execute(pool)
            .await
            .unwrap();
        for (p, printing) in ["p-o-cmd", "p-o-sol", "p-o-sig", "p-o-forest"].iter().enumerate() {
            for condition in ["NM", "LP", "MP", "HP", "DMG"] {
                sqlx::query(
                    "INSERT INTO collection_items (id, owner_id, scryfall_id, qty, condition, container_id, purchase_price, purchase_currency, note, created_at, updated_at)
                     VALUES (?, ?, ?, 2, ?, ?, 12.5, 'USD', 'Bought at the prerelease, a little wear on one corner', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')",
                )
                .bind(format!("{}-{p}", crate::util::new_id()))
                    .bind(owner)
                    .bind(printing)
                    .bind(condition)
                    .bind(&id)
                    .execute(pool)
                    .await
                    .unwrap();
            }
        }
    }
    for g in 0..3 {
        sqlx::query("INSERT INTO playgroups (id, name, owner_id, join_code, created_at) VALUES (?, ?, ?, ?, 't')")
            .bind(format!("group-{g}"))
            .bind(format!("Playgroup {g} with a long name"))
            .bind(owner)
            .bind(format!("CODE{g}"))
            .execute(pool)
            .await
            .unwrap();
        for m in 0..8 {
            sqlx::query("INSERT INTO playgroup_members (id, playgroup_id, user_id, guest_name, created_at) VALUES (?, ?, NULL, ?, 't')")
                .bind(format!("member-{g}-{m}"))
                .bind(format!("group-{g}"))
                .bind(format!("Guest {m} of group {g}"))
                .execute(pool)
                .await
                .unwrap();
        }
    }
}

#[tokio::test]
async fn default_answers_stay_small_on_a_large_account() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (owner, session) = power_user(&pool, "big@example.com").await;
    large_account(&pool, &owner).await;
    let mcp = key(&app, &session, Some("mcp")).await;

    // Every tool this caller is offered, called with nothing: an answer or a refusal, never a big one.
    let (_, listed) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("tools/list", json!({})))).await;
    let names: Vec<String> = listed["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
    assert!(names.len() > 50, "{names:?}");
    let mut sizes: Vec<(String, usize)> = Vec::new();
    for name in &names {
        let (_, text) = call(&app, &mcp, name, json!({})).await;
        sizes.push((name.clone(), text.chars().count()));
    }
    // The reads a conversation starts with, with the one argument each needs. These must answer.
    let starts = [
        ("deck", json!({"deck": deck_name(0)})),
        ("research", json!({"id": "note-00"})),
        ("review_queue", json!({"answered": true})),
        ("review_queue", json!({"plan": "plan-000"})),
        ("games", json!({"filter": "all"})),
        ("collection_cards", json!({})),
        ("collection_summary", json!({})),
        ("find_cards", json!({"query": "t:artifact"})),
        ("card", json!({"names": ["Sol Ring", "Arcane Signet"]})),
        ("lab_runs", json!({})),
        ("changes", json!({})),
        ("playgroups", json!({})),
        ("overview", json!({"section": "decks"})),
        ("overview", json!({"section": "plans"})),
        ("overview", json!({"section": "notes"})),
        ("changes", json!({"id": "change-000"})),
    ];
    for (name, args) in starts {
        let (err, text) = call(&app, &mcp, name, args.clone()).await;
        assert!(!err, "{name} {args}: {text}");
        sizes.push((format!("{name} {args}"), text.chars().count()));
    }
    let over: Vec<&(String, usize)> = sizes.iter().filter(|(_, size)| *size > DEFAULT_BUDGET).collect();
    assert!(over.is_empty(), "answers over the {DEFAULT_BUDGET}-character budget: {over:?}");

    let (err, text) = call(&app, &mcp, "overview", json!({})).await;
    assert!(!err, "{text}");
    assert!(text.chars().count() <= OVERVIEW_BUDGET, "overview is {} characters:\n{text}", text.chars().count());
    assert!(text.contains("Decks: 40, plus 80 configurations"), "{text}");
    assert!(text.contains("2 configurations: after prints, stock") || text.contains("2 configurations: stock, after prints"), "{text}");
    assert!(!text.lines().any(|l| l.starts_with("- ") && l.contains("(stock)")), "a configuration listed as a deck of its own:\n{text}");
    assert!(text.contains("Deck plans: 30") && text.contains("5 archived"), "{text}");
    assert!(text.contains(&format!("Notes: {} saved notes with {NOTE_DECKS} decks", NOTES + 1)), "{text}");
}

#[tokio::test]
async fn overview_pages_reach_everything() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (owner, session) = power_user(&pool, "big@example.com").await;
    large_account(&pool, &owner).await;
    let mcp = key(&app, &session, Some("mcp")).await;

    // The summary's cursor starts where its list stopped; following next_cursor lists every deck
    // once, each with both configurations under it.
    let (_, summary) = call(&app, &mcp, "overview", json!({})).await;
    let cursor = summary.split("cursor \"").nth(1).and_then(|rest| rest.split('"').next()).expect("a cursor for the rest of the decks").to_string();
    let mut seen: Vec<String> = summary.lines().filter(|l| l.starts_with("- Deck ")).map(|l| l[2..10].to_string()).collect();
    assert_eq!(seen.len(), 20, "{summary}");
    let mut cursor = Some(cursor);
    let (mut pages, mut configurations) = (0, 0);
    while let Some(c) = cursor.take() {
        // Seven rows a page doesn't divide a deck and its two configurations evenly: a page may
        // start or end inside a deck, and nothing is lost or repeated.
        let (err, text) = call(&app, &mcp, "overview", json!({"section": "decks", "cursor": c, "limit": 7})).await;
        assert!(!err, "{text}");
        let decks: Vec<&str> = text.lines().filter(|l| l.starts_with("- Deck ")).collect();
        let under = text.lines().filter(|l| l.starts_with("  - configuration ")).count();
        assert!(decks.len() + under <= 7, "{text}");
        assert!(decks.iter().all(|l| l.contains("(id ")), "the full listing names ids: {text}");
        assert!(text.lines().filter(|l| l.starts_with("  - configuration ")).all(|l| l.contains(" of Deck ")), "a configuration names its deck: {text}");
        seen.extend(decks.iter().map(|l| l[2..10].to_string()));
        configurations += under;
        cursor = text.lines().find_map(|l| l.strip_prefix("next_cursor: ")).map(str::to_string);
        pages += 1;
        assert!(pages < 20, "the cursor never ends");
    }
    assert_eq!(seen.len(), DECKS, "every deck listed: {seen:?}");
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), DECKS, "and none twice: {seen:?}");
    assert_eq!(configurations, 40, "the 20 decks after the summary's have 40 configurations");

    // Plans and notes page the same way, and a cursor is good only for its own list.
    let (_, text) = call(&app, &mcp, "overview", json!({"section": "plans", "limit": 100})).await;
    assert_eq!(text.lines().filter(|l| l.starts_with("- Plan ")).count(), PLANS, "{text}");
    assert!(text.contains("That is all of them."), "{text}");
    // Notes page by note deck, so one wide note is several pages and each stays small.
    let (_, first) = call(&app, &mcp, "overview", json!({"section": "notes", "limit": 5})).await;
    assert_eq!(first.lines().filter(|l| l.starts_with("  - ")).count(), 5, "{first}");
    assert!(first.lines().any(|l| l.starts_with("- ") && l.contains("(note id ")), "{first}");
    assert!(first.contains("b5 (Bracket 5 build with a label, bracket 5)"), "{first}");
    let notes_cursor = first.lines().find_map(|l| l.strip_prefix("next_cursor: ")).unwrap().to_string();
    let mut note_decks: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    for page in 0.. {
        assert!(page < 20, "the cursor never ends");
        let args = match &cursor {
            Some(c) => json!({"section": "notes", "cursor": c}),
            None => json!({"section": "notes"}),
        };
        let (err, text) = call(&app, &mcp, "overview", args).await;
        assert!(!err, "{text}");
        assert!(text.chars().count() <= DEFAULT_BUDGET, "a notes page is {} characters", text.chars().count());
        note_decks.extend(text.lines().filter(|l| l.starts_with("  - ")).filter_map(|l| l.split("(deck key ").nth(1)).map(|rest| rest.split(')').next().unwrap().to_string()));
        cursor = text.lines().find_map(|l| l.strip_prefix("next_cursor: ")).map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(note_decks.len(), NOTE_DECKS, "every note deck listed");
    note_decks.sort();
    note_decks.dedup();
    assert_eq!(note_decks.len(), NOTE_DECKS, "and none twice");
    let notes_cursor = notes_cursor.as_str();
    let (err, text) = call(&app, &mcp, "overview", json!({"section": "plans", "cursor": notes_cursor})).await;
    assert!(err && text.contains("cursor"), "{text}");
    let (err, text) = call(&app, &mcp, "overview", json!({"cursor": notes_cursor})).await;
    assert!(err && text.contains("section"), "{text}");
    let (err, text) = call(&app, &mcp, "overview", json!({"section": "everything"})).await;
    assert!(err && text.contains("decks, plans or notes"), "{text}");

    // Another account sees none of it, in any section.
    let (_, other) = power_user(&pool, "other@example.com").await;
    let other = key(&app, &other, Some("mcp")).await;
    for args in [json!({}), json!({"section": "decks"}), json!({"section": "plans"}), json!({"section": "notes"})] {
        let (err, text) = call(&app, &other, "overview", args).await;
        assert!(!err, "{text}");
        assert!(!text.contains("Deck 0") && !text.contains("Plan 0") && !text.contains("Research note"), "{text}");
    }
}

#[tokio::test]
async fn the_review_queue_and_changes_page_with_a_cursor() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (owner, session) = power_user(&pool, "big@example.com").await;
    large_account(&pool, &owner).await;
    sqlx::query("INSERT INTO plan_reviews (owner_id, swap_key, decision, at, origin) VALUES (?, 'key-0-0', 'want', '2026-11-01T00:00:00Z', 'yama')").bind(&owner).execute(&pool).await.unwrap();
    let mcp = key(&app, &session, Some("mcp")).await;

    // 25 live plans with 12 proposals each, one of them answered: the default lists 20 waiting.
    let (err, first) = call(&app, &mcp, "review_queue", json!({})).await;
    assert!(!err, "{first}");
    assert!(first.contains("- Plan 000, with a long name too: 11 waiting for an answer, 1 answered"), "{first}");
    assert!(first.contains("Swaps 1 to 15 of 299 waiting for an answer"), "{first}");
    assert!(first.contains("\nPlan 000, with a long name too, waiting for an answer:") && first.contains("Want means an agent moves the swap"), "{first}");
    assert!(!first.contains("Plan 025"), "an archived plan's proposals aren't in Review: {first}");
    assert!(!first.contains("Their answer: want"), "answered swaps are only counted by default: {first}");
    let next = first.lines().find_map(|l| l.strip_prefix("next_cursor: ")).unwrap();
    let (err, second) = call(&app, &mcp, "review_queue", json!({"cursor": next})).await;
    assert!(!err && second.contains("Swaps 16 to 30 of 299"), "{second}");
    // The next page goes on where the first stopped: the rest of the second plan, then the third.
    assert!(!second.contains("\nPlan 000, with a long name too, waiting") && second.contains("\nPlan 001, with a long name too, waiting") && second.contains("\nPlan 002, with a long name too, waiting"), "{second}");
    assert_eq!(first.matches("\n- Card in ").count() + second.matches("\n- Card in ").count(), 30, "15 swaps a page");
    let (err, text) = call(&app, &mcp, "review_queue", json!({"cursor": next, "answered": true})).await;
    assert!(err && text.contains("cursor"), "a cursor is for one listing: {text}");

    let (err, one) = call(&app, &mcp, "review_queue", json!({"plan": "plan-000", "answered": true})).await;
    assert!(!err, "{one}");
    assert!(one.contains("Swaps 1 to 12 of 12") && one.contains("Their answer: want") && !one.contains("Plan 001"), "{one}");
    assert!(!one.contains("next_cursor"), "{one}");
    let (err, text) = call(&app, &mcp, "review_queue", json!({"plan": "no such plan"})).await;
    assert!(err && text == "plan deck not found", "{text}");

    let (err, first) = call(&app, &mcp, "changes", json!({})).await;
    assert!(!err && first.starts_with("50 changes are waiting"), "{first}");
    assert_eq!(first.lines().filter(|l| l.starts_with("- ")).count(), 25, "{first}");
    assert!(first.lines().all(|l| l.chars().count() < 600), "a long summary is cut: {first}");
    assert!(first.contains("`list_changes` with this id shows it whole"), "{first}");
    let next = first.lines().find_map(|l| l.strip_prefix("next_cursor: ")).unwrap();
    let (_, second) = call(&app, &mcp, "changes", json!({"cursor": next})).await;
    assert_eq!(second.lines().filter(|l| l.starts_with("- ")).count(), 25, "{second}");
    assert!(!second.contains("next_cursor"), "{second}");
    let ids = |text: &str| -> Vec<String> { text.split("(id ").skip(1).map(|rest| rest.split(',').next().unwrap().to_string()).collect() };
    let mut all = ids(&first);
    all.extend(ids(&second));
    assert_eq!(all.len(), 50);
    all.sort();
    all.dedup();
    assert_eq!(all.len(), 50, "the second page repeats none of the first");
    // One change whole, for checking exactly what applying it would do; only the owner's.
    let (err, whole) = call(&app, &mcp, "changes", json!({"id": "change-007"})).await;
    assert!(!err && whole.starts_with("Change change-007 (pending") && whole.chars().count() > 1000, "{whole}");
    let (_, other) = power_user(&pool, "other@example.com").await;
    let other = key(&app, &other, Some("mcp")).await;
    let (err, text) = call(&app, &other, "changes", json!({"id": "change-007"})).await;
    assert!(err && text == "change not found", "{text}");

    // Games: 10 by default, more on request, and next_offset walks the rest.
    let (_, text) = call(&app, &mcp, "games", json!({})).await;
    let page: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(page["games"].as_array().unwrap().len(), 10);
    assert_eq!(page["has_more"], true);
    assert_eq!(page["next_offset"], 10);
    assert_eq!(page["games"][0]["seats"][1]["display_name"], "Player with a long name 1");
    assert!(page["games"][0]["seats"][1].get("guest_name").is_none(), "the name isn't said twice: {text}");
    assert!(!text.contains("null"), "empty fields are left out: {text}");
    let (_, text) = call(&app, &mcp, "games", json!({"offset": 100, "limit": 50})).await;
    let page: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(page["games"].as_array().unwrap().len(), 20, "the last 20 of 120");
    assert_eq!(page["has_more"], false);
    assert!(page.get("next_offset").is_none(), "{text}");
}

/// One call through the endpoint, whole: the result object.
async fn result(app: &axum::Router, token: &str, tool: &str, args: Value) -> Value {
    let (status, r) = send(app, Method::POST, "/mcp", Some(token), Some(rpc("tools/call", json!({"name": tool, "arguments": args})))).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{r}");
    r["result"].clone()
}

fn text_of(result: &Value) -> &str {
    result["content"][0]["text"].as_str().unwrap()
}

#[tokio::test]
async fn a_long_answer_is_cut_and_continued_not_refused() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (owner, session) = power_user(&pool, "big@example.com").await;
    large_account(&pool, &owner).await;
    let mcp = key(&app, &session, Some("mcp")).await;

    // The wide note in full is longer than one answer may be: it arrives in parts.
    let ask = json!({"id": "note-wide", "detail": "full"});
    let first = result(&app, &mcp, "research", ask.clone()).await;
    assert_eq!(first["isError"], false, "{first}");
    assert_eq!(first["structuredContent"]["cut"], true, "a part isn't the object: {}", first["structuredContent"]);
    let mut whole = String::new();
    let mut part = first;
    for parts in 1.. {
        assert!(parts < 10, "the chunks never end");
        let text = text_of(&part);
        assert!(text.chars().count() <= super::registry::MAX_ANSWER + 400, "a part is {} characters", text.chars().count());
        match text.split_once("\n[Cut for length: ") {
            Some((body, notice)) => {
                whole.push_str(body);
                let chunk = notice.split("chunk \"").nth(1).and_then(|rest| rest.split('"').next()).expect("the next chunk");
                assert_eq!(part["structuredContent"]["next_chunk"], chunk);
                assert_eq!(part["structuredContent"]["part"], body, "a client that reads only the structured form gets the part too");
                let mut again = ask.clone();
                again["chunk"] = json!(chunk);
                part = result(&app, &mcp, "research", again).await;
                assert_eq!(part["isError"], false, "{part}");
            }
            None => {
                whole.push_str(text);
                break;
            }
        }
    }
    // The parts together are the answer, exactly.
    let document: Value = serde_json::from_str(&whole).expect("the parts join into the JSON answer");
    assert_eq!(document["document"]["decks"].as_array().unwrap().len(), WIDE_NOTE_DECKS);
    let (err, direct) = call(&app, &mcp, "research", json!({"id": "note-wide", "full": true, "deck": "wide-00"})).await;
    assert!(!err && direct.chars().count() < super::registry::MAX_ANSWER, "one deck of it fits in one answer");

    // A chunk is for the tool and answer it came from.
    // A chunk continues one answer: this tool, these arguments, this text. Anything else is refused.
    let first_chunk = text_of(&result(&app, &mcp, "research", ask.clone()).await).split("chunk \"").nth(1).and_then(|rest| rest.split('"').next()).unwrap().to_string();
    let bad = result(&app, &mcp, "research", json!({"id": "note-wide", "detail": "full", "chunk": "nonsense"})).await;
    assert!(bad["isError"] == true && text_of(&bad).contains("chunk doesn't continue this answer"), "{bad}");
    let other_tool = result(&app, &mcp, "overview", json!({"chunk": first_chunk})).await;
    assert!(other_tool["isError"] == true && text_of(&other_tool).contains("chunk doesn't continue this answer"), "{other_tool}");
    let other_arguments = result(&app, &mcp, "research", json!({"id": "note-00", "detail": "full", "chunk": first_chunk})).await;
    assert!(other_arguments["isError"] == true && text_of(&other_arguments).contains("chunk doesn't continue this answer"), "another note isn't continued from this one's chunk: {other_arguments}");
    // The answer changed since (the note was saved again): the old chunk no longer fits it.
    sqlx::query("UPDATE research_reports SET document = json_set(document, '$.title', 'A collection-wide audit, retitled') WHERE owner_id = ? AND id = 'note-wide'").bind(&owner).execute(&pool).await.unwrap();
    let changed = result(&app, &mcp, "research", json!({"id": "note-wide", "detail": "full", "chunk": first_chunk})).await;
    assert!(changed["isError"] == true && text_of(&changed).contains("the answer has changed since"), "{changed}");

    // Reading the rest of an answer runs the tool again, so a tool that stages or writes can't
    // be continued: it is refused before it runs, and nothing is staged.
    let changes = || async { sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM assistant_changes WHERE owner_id = ?").bind(&owner).fetch_one(&pool).await.unwrap() };
    let before = changes().await;
    let again = result(&app, &mcp, "add_wish", json!({"name": "Sol Ring", "chunk": super::page::cursor("chunk.add_wish", 40_000)})).await;
    assert!(again["isError"] == true && text_of(&again).contains("never run again"), "{again}");
    let again = result(&app, &mcp, "save_research", json!({"document": {}, "chunk": "anything"})).await;
    assert!(again["isError"] == true && text_of(&again).contains("never run again"), "{again}");
    assert_eq!(changes().await, before);
}

#[tokio::test]
async fn data_answers_are_structured_paged_by_cursor_and_say_whose_text_they_carry() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (owner, session) = power_user(&pool, "big@example.com").await;
    large_account(&pool, &owner).await;
    let mcp = key(&app, &session, Some("mcp")).await;

    // A JSON answer is also structured content, the same object; a list goes under `items`.
    let summary = result(&app, &mcp, "collection_summary", json!({})).await;
    assert_eq!(summary["structuredContent"], serde_json::from_str::<Value>(text_of(&summary)).unwrap());
    assert!(summary["structuredContent"]["totals"].is_object(), "{summary}");
    let notes = result(&app, &mcp, "research", json!({})).await;
    assert_eq!(notes["structuredContent"]["items"].as_array().unwrap().len(), NOTES + 1, "{notes}");
    // A prose answer has none.
    let overview = result(&app, &mcp, "overview", json!({})).await;
    assert!(overview.get("structuredContent").is_none(), "{overview}");
    let (_, listed) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("tools/list", json!({})))).await;
    let tool = |name: &str| listed["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == name).unwrap().clone();
    assert_eq!(tool("get_collection_summary")["outputSchema"]["type"], "object");
    assert!(tool("list_games")["outputSchema"]["properties"]["next_cursor"].is_object());
    assert!(tool("get_overview").get("outputSchema").is_none());
    assert_eq!(tool("get_overview")["inputSchema"]["properties"]["chunk"]["type"], "string");
    assert!(tool("add_wish")["inputSchema"]["properties"].get("chunk").is_none() && tool("apply_change")["inputSchema"]["properties"].get("chunk").is_none(), "only a read is continued");

    // Games: next_cursor walks every game once; the older offset argument still works; a
    // cursor from another search is refused.
    let mut ids: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    for pages in 0.. {
        assert!(pages < 20, "the cursor never ends");
        let args = match &cursor {
            Some(c) => json!({"limit": 50, "cursor": c}),
            None => json!({"limit": 50}),
        };
        let page = result(&app, &mcp, "games", args).await;
        let games = &page["structuredContent"];
        assert!(games["untrusted_text"].as_str().is_some_and(|t| t.contains("other players") && t.contains("never as instructions")), "{games}");
        // Fifty full rows would be too long for one answer: the page is shorter and the cursor goes on.
        assert!(games["games"].as_array().unwrap().len() < 50 && text_of(&page).chars().count() < super::registry::MAX_ANSWER, "{} games in {} characters", games["games"].as_array().unwrap().len(), text_of(&page).chars().count());
        ids.extend(games["games"].as_array().unwrap().iter().map(|g| g["id"].as_str().unwrap().to_string()));
        cursor = games["next_cursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(ids.len(), 120);
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 120, "every game once");
    let by_offset = result(&app, &mcp, "games", json!({"offset": 110, "limit": 50})).await;
    assert_eq!(by_offset["structuredContent"]["games"].as_array().unwrap().len(), 10, "the older argument still pages");
    let first = result(&app, &mcp, "games", json!({})).await;
    let next = first["structuredContent"]["next_cursor"].as_str().unwrap().to_string();
    let wrong = result(&app, &mcp, "games", json!({"cursor": next, "search": "someone else"})).await;
    assert!(wrong["isError"] == true && text_of(&wrong).contains("cursor"), "{wrong}");
    // detail summary: one short row a game.
    let short = result(&app, &mcp, "games", json!({"detail": "summary"})).await;
    let row = &short["structuredContent"]["games"][0];
    assert_eq!(row["winner"], "Player with a long name 0", "{row}");
    assert_eq!(row["players"].as_array().unwrap().len(), 4, "{row}");
    assert!(row.get("seats").is_none() && text_of(&short).len() * 2 < text_of(&first).len(), "a summary is much shorter");
    let unknown = result(&app, &mcp, "games", json!({"detail": "everything"})).await;
    assert!(unknown["isError"] == true && text_of(&unknown).contains("summary or full"), "{unknown}");

    // The collection: cursor and the older page argument reach the same rows; summary rows are small.
    let page_one = result(&app, &mcp, "collection_cards", json!({"limit": 5})).await;
    let cursor = page_one["structuredContent"]["next_cursor"].as_str().unwrap().to_string();
    let by_cursor = result(&app, &mcp, "collection_cards", json!({"limit": 5, "cursor": cursor})).await;
    let by_page = result(&app, &mcp, "collection_cards", json!({"limit": 5, "page": 2})).await;
    assert_eq!(by_cursor["structuredContent"]["items"], by_page["structuredContent"]["items"]);
    assert_ne!(by_cursor["structuredContent"]["items"], page_one["structuredContent"]["items"]);
    let small = result(&app, &mcp, "collection_cards", json!({"limit": 5, "detail": "summary"})).await;
    let item = &small["structuredContent"]["items"][0];
    assert!(item.get("id").is_none() && item["qty"] == 2 && item.get("unit_price_usd").is_some_and(Value::is_null) && item.get("price_date").is_some_and(Value::is_null), "a missing price is null beside its date: {item}");

    // Card search is data: a card with no recorded price has a null price and date, never 0 or words.
    let found = result(&app, &mcp, "find_cards", json!({"query": "t:artifact"})).await;
    let cards = found["structuredContent"]["cards"].as_array().unwrap();
    assert_eq!(cards.len(), 2, "{found}");
    assert!(cards.iter().all(|c| c["price_usd"].is_null() && c["price_date"].is_null() && c["commander"] == "legal"), "{found}");
    assert!(!text_of(&found).contains("no price") && found["structuredContent"]["next_cursor"].is_null(), "{found}");
    let paged = result(&app, &mcp, "find_cards", json!({"query": "t:artifact", "page": 1})).await;
    assert_eq!(paged["structuredContent"]["cards"], found["structuredContent"]["cards"], "the older page argument");
}
