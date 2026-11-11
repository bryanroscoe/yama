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

fn deck_name(i: usize) -> String {
    format!("Deck {i:03}, with the kind of long name people give a deck")
}

/// An account bigger than Bryan's: decks with configurations, plans with proposals, notes with
/// many builds, games, lab runs, staged changes, containers and playgroups.
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
    for g in 0..120 {
        let id = format!("game-{g:03}");
        sqlx::query("INSERT INTO games (id, mode, created_by, status, started_at, turns, winner_seat, note) VALUES (?, 'in_person', ?, 'finished', ?, 9, 0, 'A long game with a note about how it went and who did what')")
            .bind(&id)
            .bind(owner)
            .bind(format!("2026-10-{:02}T20:{:02}:00Z", g % 28 + 1, g % 60))
            .execute(pool)
            .await
            .unwrap();
        for seat in 0..4 {
            sqlx::query("INSERT INTO game_seats (game_id, seat, guest_name, commander_name, deck_label, final_life) VALUES (?, ?, ?, 'Atraxa, Praetors'' Voice', 'A precon with a long label', 12)")
                .bind(&id)
                .bind(seat)
                .bind(format!("Player with a name {seat}"))
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
        let id = format!("box-{b:02}");
        sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at) VALUES (?, ?, 'binder', ?, 't')")
            .bind(&id)
            .bind(owner)
            .bind(format!("Binder {b:02} with a long descriptive name"))
            .execute(pool)
            .await
            .unwrap();
        for (p, printing) in ["p-o-cmd", "p-o-sol", "p-o-sig", "p-o-forest"].iter().enumerate() {
            for condition in ["NM", "LP", "MP", "HP", "DMG"] {
                sqlx::query("INSERT INTO collection_items (id, owner_id, scryfall_id, qty, condition, container_id, created_at, updated_at) VALUES (?, ?, ?, 2, ?, ?, 't', 't')")
                    .bind(format!("item-{b}-{p}-{condition}"))
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
    assert!(text.contains("Notes: 12 saved notes with 48 decks"), "{text}");
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
    let mut pages = 0;
    while let Some(c) = cursor.take() {
        let (err, text) = call(&app, &mcp, "overview", json!({"section": "decks", "cursor": c, "limit": 7})).await;
        assert!(!err, "{text}");
        let decks: Vec<&str> = text.lines().filter(|l| l.starts_with("- Deck ")).collect();
        assert!(decks.len() <= 7, "{text}");
        assert_eq!(text.lines().filter(|l| l.starts_with("  - configuration ")).count(), decks.len() * 2, "{text}");
        assert!(decks.iter().all(|l| l.contains("(id ")), "the full listing names ids: {text}");
        seen.extend(decks.iter().map(|l| l[2..10].to_string()));
        cursor = text.lines().find_map(|l| l.strip_prefix("next_cursor: ")).map(str::to_string);
        pages += 1;
        assert!(pages < 10, "the cursor never ends");
    }
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), DECKS, "every deck once: {seen:?}");

    // Plans and notes page the same way, and a cursor is good only for its own list.
    let (_, text) = call(&app, &mcp, "overview", json!({"section": "plans", "limit": 100})).await;
    assert_eq!(text.lines().filter(|l| l.starts_with("- Plan ")).count(), PLANS, "{text}");
    assert!(text.contains("That is all of them."), "{text}");
    let (_, first) = call(&app, &mcp, "overview", json!({"section": "notes", "limit": 5})).await;
    assert_eq!(first.lines().filter(|l| l.starts_with("- Research note ")).count(), 5, "{first}");
    assert_eq!(first.lines().filter(|l| l.starts_with("  - Note deck ")).count(), 20, "{first}");
    assert!(first.contains("b5 (Bracket 5 build with a label, bracket 5)"), "{first}");
    let notes_cursor = first.lines().find_map(|l| l.strip_prefix("next_cursor: ")).unwrap();
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
    assert!(first.contains("Swaps 1 to 20 of 299 waiting for an answer"), "{first}");
    assert!(!first.contains("Plan 025"), "an archived plan's proposals aren't in Review: {first}");
    assert!(!first.contains("Their answer: want"), "answered swaps are only counted by default: {first}");
    let next = first.lines().find_map(|l| l.strip_prefix("next_cursor: ")).unwrap();
    let (err, second) = call(&app, &mcp, "review_queue", json!({"cursor": next})).await;
    assert!(!err && second.contains("Swaps 21 to 40 of 299"), "{second}");
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
    assert!(first.lines().all(|l| l.chars().count() < 400), "a long summary is cut: {first}");
    let next = first.lines().find_map(|l| l.strip_prefix("next_cursor: ")).unwrap();
    let (_, second) = call(&app, &mcp, "changes", json!({"cursor": next})).await;
    assert_eq!(second.lines().filter(|l| l.starts_with("- ")).count(), 25, "{second}");
    assert!(!second.contains("next_cursor"), "{second}");

    // Games: 15 by default, more on request, and next_offset walks the rest.
    let (_, text) = call(&app, &mcp, "games", json!({})).await;
    let page: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(page["games"].as_array().unwrap().len(), 15);
    assert_eq!(page["has_more"], true);
    assert_eq!(page["next_offset"], 15);
    assert!(!text.contains("null"), "empty fields are left out: {text}");
    let (_, text) = call(&app, &mcp, "games", json!({"offset": 100, "limit": 50})).await;
    let page: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(page["games"].as_array().unwrap().len(), 20, "the last 20 of 120");
    assert_eq!(page["has_more"], false);
    assert!(page.get("next_offset").is_none(), "{text}");
}
