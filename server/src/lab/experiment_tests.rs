//! "Try a change" end to end against an in-memory database, with a fake simulator so the worker's
//! games take microseconds: validation, isolation, limits, pairing, the worker's order, resuming
//! after a restart, cancelling and deleting, and the 503 without engine card data.

use super::experiments::*;
use super::pairing::{LIMITS, Limits};
use super::stats::{VerdictKind, BASE_ID, VARIANT_ID};
use super::worker::{LabWorker, MAX_ATTEMPTS, SimState, Simulator, store};
use crate::auth::User;
use crate::decks::{Board, DeckCard};
use crate::error::AppError;
use axum::response::IntoResponse;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use yama_play::lab::{End, GameResult, GameSpec, MAX_TURN_ACTIONS};

/// Plays instantly: the tested seat wins when seed % 10 < 2, and the changed list also wins when
/// seed % 10 is 2 or 3, so the changed list is better by about 20 points. Names in `unknown` are
/// cards the "engine" can't play. Every game it plays is recorded with the decks it was given and
/// the per-turn loop cap it was played under. `stuck` stands in for hung game threads.
#[derive(Default)]
struct FakeSim {
    unknown: HashSet<String>,
    fail: bool,
    stuck: AtomicUsize,
    played: Mutex<Vec<(GameSpec, Vec<String>)>>,
    loop_caps: Mutex<Vec<usize>>,
}

impl FakeSim {
    fn new() -> Arc<Self> {
        Arc::new(FakeSim { unknown: HashSet::from(["Mystery Card".to_string()]), ..Default::default() })
    }
    fn played(&self) -> Vec<(GameSpec, Vec<String>)> {
        self.played.lock().unwrap().clone()
    }
}

impl Simulator for FakeSim {
    fn card_data(&self) -> String {
        "fakecarddata0000".into()
    }
    fn unknown(&self, cards: &[LabCard]) -> Vec<String> {
        cards.iter().filter(|c| self.unknown.contains(&c.name)).map(|c| c.name.clone()).collect()
    }
    fn stuck(&self) -> usize {
        self.stuck.load(Ordering::SeqCst)
    }
    fn play(&self, spec: &GameSpec, decks: &[Arc<LabList>], limits: &Limits) -> GameResult {
        self.played.lock().unwrap().push((spec.clone(), decks.iter().map(|d| d.id.clone()).collect()));
        self.loop_caps.lock().unwrap().push(limits.turn_action_cap);
        let mut r = GameResult::new(spec, "fakecarddata0000");
        if self.fail {
            r.error = Some("engine refused everything".into());
            return r;
        }
        let seat = spec.decks.iter().position(|d| d == BASE_ID || d == VARIANT_ID).unwrap() as u8;
        let roll = spec.seed % 10;
        let wins = roll < 2 || (spec.decks[seat as usize] == VARIANT_ID && roll < 4);
        let winner = if wins { seat } else { (seat + 1) % 4 };
        r.end = End::Win;
        r.winner = Some(winner);
        r.first_seat = Some(0);
        r.placements = vec![vec![winner], (0..4).filter(|s| *s != winner).collect()];
        r.turns = 9;
        r
    }
}

fn user(id: &str, admin: bool) -> User {
    User { id: id.into(), email: format!("{id}@example.com"), display_name: id.into(), is_admin: admin }
}

async fn add_user(pool: &SqlitePool, id: &str, admin: bool) {
    sqlx::query("INSERT INTO users (id, email, display_name, is_admin, created_at) VALUES (?,?,?,?, 'now')")
        .bind(id)
        .bind(format!("{id}@example.com"))
        .bind(id)
        .bind(admin)
        .execute(pool)
        .await
        .unwrap();
}

async fn card(pool: &SqlitePool, name: &str, type_line: &str, ci: &str, legal: &str) {
    let oid = format!("o-{}", name.to_lowercase().replace([' ', ','], "-"));
    sqlx::query(
        "INSERT INTO cards (oracle_id, name, type_line, color_identity, legalities, image_art_crop, artist, updated_at)
         VALUES (?,?,?,?,?,?, 'An Artist', 'now')",
    )
    .bind(&oid)
    .bind(name)
    .bind(type_line)
    .bind(ci)
    .bind(format!("{{\"commander\":\"{legal}\"}}"))
    .bind(format!("https://cards.scryfall.io/art_crop/{oid}.jpg"))
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?,?)").bind(name).bind(&oid).execute(pool).await.unwrap();
}

fn oid(name: &str) -> String {
    format!("o-{}", name.to_lowercase().replace([' ', ','], "-"))
}

/// A 100-card list: the commander, Sol Ring, `extra` and Forests.
fn list_of(commander: &str, extra: &[&str]) -> Vec<(String, u32, bool)> {
    let mut v = vec![(commander.to_string(), 1, true), ("Sol Ring".to_string(), 1, false)];
    v.extend(extra.iter().map(|n| (n.to_string(), 1, false)));
    v.push(("Forest".into(), 98 - extra.len() as u32, false));
    v
}

/// Users bryan and other (not admins) and admin; cards; six precons (p6 has a card the engine
/// can't play) and a global rating run that rates p1 to p5.
async fn fixture() -> SqlitePool {
    let pool = crate::db::test_pool().await;
    add_user(&pool, "bryan", false).await;
    add_user(&pool, "other", false).await;
    add_user(&pool, "admin", true).await;
    for c in ["Ghave", "Atla", "Bruna", "Cadric", "Dina", "Ezuri"] {
        card(&pool, c, "Legendary Creature — Elf", "G", "legal").await;
    }
    card(&pool, "Forest", "Basic Land — Forest", "G", "legal").await;
    card(&pool, "Sol Ring", "Artifact", "", "legal").await;
    card(&pool, "Llanowar Elves", "Creature — Elf Druid", "G", "legal").await;
    card(&pool, "Elvish Mystic", "Creature — Elf Druid", "G", "legal").await;
    card(&pool, "Lightning Bolt", "Instant", "R", "legal").await;
    card(&pool, "Black Lotus", "Artifact", "", "banned").await;
    card(&pool, "Grizzly Bears", "Creature — Bear", "G", "legal").await;
    card(&pool, "Mystery Card", "Artifact", "", "legal").await;
    let precons = [("p1", "Ghave", 2.2, &[][..]), ("p2", "Atla", 1.5, &[]), ("p3", "Bruna", 1.0, &[]), ("p4", "Cadric", 0.8, &[]), ("p5", "Dina", 0.5, &[]), ("p6", "Ezuri", 0.0, &["Mystery Card"])];
    for (slug, commander, _, extra) in precons {
        let cards: Vec<Value> = list_of(commander, extra)
            .into_iter()
            .map(|(name, qty, cmd)| json!({"name": name, "oracle_id": oid(&name), "qty": qty, "board": if cmd { "commander" } else { "main" }}))
            .collect();
        sqlx::query(
            "INSERT INTO precons (id, lab_id, name, set_code, commanders, color_identity, cards, source, content_sha256, imported_at)
             VALUES (?,?,?, 'TST', ?, 'G', ?, 'test', 'x', 'now')",
        )
        .bind(slug)
        .bind(format!("precons/{slug}"))
        .bind(format!("Precon {slug}"))
        .bind(json!([commander]).to_string())
        .bind(json!(cards).to_string())
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO lab_runs (id, owner_id, name, kind, games, created_at, imported_at, summary, summary_sha256)
         VALUES ('run1', NULL, 'r1', 'precon-ratings', 500, '2026-10-19', 'now', '{}', 'x')",
    )
    .execute(&pool)
    .await
    .unwrap();
    for (rank, (slug, _, strength, _)) in precons.iter().take(5).enumerate() {
        sqlx::query("INSERT INTO lab_ratings (run_id, deck_ref, strength, games, extra) VALUES ('run1', ?, ?, 100, ?)")
            .bind(format!("precons/{slug}"))
            .bind(strength)
            .bind(json!({"rank": rank + 1}).to_string())
            .execute(&pool)
            .await
            .unwrap();
    }
    pool
}

fn req(v: Value) -> NewExperiment {
    serde_json::from_value(v).unwrap()
}

/// A precon base with two swaps against the strongest three other precons.
fn swap_req(games: u32) -> NewExperiment {
    req(json!({
        "base": {"kind": "precon", "id": "p1"},
        "variant": {"cut": ["Forest", "Forest"], "add": ["Llanowar Elves", "Elvish Mystic"]},
        "field": {"kind": "precons_top", "n": 3},
        "games": games
    }))
}

async fn deck(pool: &SqlitePool, owner: &str, name: &str, cards: Vec<(String, u32, bool)>) -> String {
    let cards = cards
        .into_iter()
        .map(|(n, q, c)| DeckCard { oracle_id: oid(&n), name: n, qty: i64::from(q), board: if c { Board::Commander } else { Board::Main } })
        .collect();
    crate::decks::create_deck_with_cards(pool, owner, name, None, cards).await.unwrap()
}

fn invalid(e: AppError) -> (String, Value) {
    match e {
        AppError::Invalid { message, details } => (message, details),
        other => panic!("expected Invalid, got {other:?}"),
    }
}

fn bad(e: AppError) -> String {
    match e {
        AppError::BadRequest(m) => m,
        other => panic!("expected BadRequest, got {other:?}"),
    }
}

#[tokio::test]
async fn an_experiment_is_frozen_and_paired_when_created() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let d = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    assert_eq!(d.item.status, "queued");
    assert_eq!((d.item.progress.done, d.item.progress.total), (0, 100));
    assert_eq!(d.item.name, "Precon p1: \u{2212}2 Forest, +Elvish Mystic, +Llanowar Elves");
    let field = d.item.field.as_ref().unwrap();
    assert_eq!(field.label, "Strongest 3 precons in rating run r1");
    assert_eq!(field.run.as_ref().map(|r| r.name.as_str()), Some("r1"));
    // The base precon is never its own opponent: the strongest three others.
    let mut ids: Vec<&str> = d.opponents.iter().map(|o| o.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec!["precons/p2", "precons/p3", "precons/p4"]);
    assert_eq!(d.opponents.iter().map(|o| o.pods).sum::<usize>(), 150);
    let v = d.item.variant.as_ref().unwrap();
    assert_eq!(v.cut.iter().map(|c| (c.name.as_str(), c.qty)).collect::<Vec<_>>(), vec![("Forest", 2)]);
    assert_eq!(v.added.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["Elvish Mystic", "Llanowar Elves"]);
    let base = d.item.base.as_ref().unwrap();
    assert_eq!((base.commanders.clone(), base.color_identity.as_str()), (vec!["Ghave".to_string()], "G"));
    assert_eq!(base.art.as_ref().map(|a| a.card.as_str()), Some("Ghave"));
    assert_eq!((d.item.label.engine.as_str(), d.item.label.card_data.as_str(), d.item.label.difficulty.as_str()), ("phase-rs v0.113.0", "fakecarddata0000", "Easy"));
    assert!(d.item.label.simulated);
    assert_eq!(d.lists.base.cards.iter().map(|c| c.qty).sum::<u32>(), 100);
    assert_eq!(d.lists.variant.cards.iter().map(|c| c.qty).sum::<u32>(), 100);
    assert_ne!(d.lists.base.sha256, d.lists.variant.sha256);
    assert!(d.item.summary.is_none());

    // 50 pods, two games each: same seed and opponents, the lists in the same seat.
    let rows: Vec<(i64, String)> =
        sqlx::query_as("SELECT ord, spec FROM lab_experiment_games WHERE experiment_id = ? ORDER BY ord").bind(&d.item.id).fetch_all(&pool).await.unwrap();
    assert_eq!(rows.len(), 100);
    for pair in rows.chunks(2) {
        let b: GameSpec = serde_json::from_str(&pair[0].1).unwrap();
        let v: GameSpec = serde_json::from_str(&pair[1].1).unwrap();
        assert_eq!((pair[0].0 % 2, pair[1].0), (0, pair[0].0 + 1));
        assert_eq!(b.seed, v.seed);
        let seat = b.decks.iter().position(|x| x == "base").unwrap();
        assert_eq!(v.decks[seat], "variant");
        assert_eq!(seat, (pair[0].0 / 2) as usize % 4);
        let others = |s: &GameSpec| s.decks.iter().enumerate().filter(|(i, _)| *i != seat).map(|(_, d)| d.clone()).collect::<Vec<_>>();
        assert_eq!(others(&b), others(&v));
        assert_eq!((b.max_turns, b.max_actions, b.max_seconds, b.difficulty.as_str()), (120, 200_000, 600, "Easy"));
    }
}

#[tokio::test]
async fn bad_requests_say_what_is_wrong() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let bryan = user("bryan", false);
    let admin = user("admin", true);
    let mk = |variant: Value, field: Value, games: u32| req(json!({"base": {"kind": "precon", "id": "p1"}, "variant": variant, "field": field, "games": games}));
    let top3 = json!({"kind": "precons_top", "n": 3});

    // Names neither Yama nor the engine knows, per list.
    let (msg, details) = invalid(create(&pool, &bryan, mk(json!({"cut": ["Forest", "Forest"], "add": ["Not A Card", "Mystery Card"]}), top3.clone(), 100), sim.as_ref()).await.unwrap_err());
    assert!(msg.contains("Not A Card") && msg.contains("Mystery Card"), "{msg}");
    assert_eq!(details["unknown"]["variant"], json!(["Not A Card", "Mystery Card"]));
    assert_eq!(details["unknown"]["base"], json!([]));
    // A pasted base list with an unknown card names it under base.
    let (_, details) = invalid(
        create(&pool, &bryan, req(json!({"base": {"kind": "list", "text": "1 Ghave\n1 Nope Card\n98 Forest"}, "variant": {"add": ["Sol Ring"], "cut": ["Forest"]}, "field": top3, "games": 100})), sim.as_ref())
            .await
            .unwrap_err(),
    );
    assert_eq!(details["unknown"]["base"], json!(["Nope Card"]));

    // 99 cards, and a commander that can't be one, block; the problems say which list.
    let (msg, details) = invalid(create(&pool, &bryan, mk(json!({"cut": ["Forest"]}), top3.clone(), 100), sim.as_ref()).await.unwrap_err());
    assert!(msg.contains("99 cards"), "{msg}");
    assert!(details["problems"]["variant"][0].as_str().unwrap().contains("99 cards"));
    let bears = req(json!({"base": {"kind": "list", "text": "1 Grizzly Bears\n1 Sol Ring\n98 Forest"}, "variant": {"add": ["Llanowar Elves"], "cut": ["Forest"]}, "field": top3, "games": 100}));
    let (_, details) = invalid(create(&pool, &bryan, bears, sim.as_ref()).await.unwrap_err());
    assert!(details["problems"]["base"][0].as_str().unwrap().contains("can't be a commander"), "{details}");
    // Cutting a card the base doesn't have, or its commander.
    let (msg, _) = invalid(create(&pool, &bryan, mk(json!({"cut": ["Llanowar Elves"], "add": ["Elvish Mystic"]}), top3.clone(), 100), sim.as_ref()).await.unwrap_err());
    assert!(msg.contains("Llanowar Elves isn't in the base list"), "{msg}");
    let (msg, _) = invalid(create(&pool, &bryan, mk(json!({"cut": ["Ghave"], "add": ["Atla"]}), top3.clone(), 100), sim.as_ref()).await.unwrap_err());
    assert!(msg.contains("Ghave is the commander"), "{msg}");
    // A change that changes nothing.
    let same = mk(json!({"text": "Commander\n1 Ghave\nDeck\n1 Sol Ring\n98 Forest"}), top3.clone(), 100);
    assert!(bad(create(&pool, &bryan, same, sim.as_ref()).await.unwrap_err()).contains("same as the base"));
    // Two commanders that can't pair block too.
    let pair = req(json!({"base": {"kind": "list", "text": "Commander\n1 Ghave\n1 Atla\nDeck\n1 Sol Ring\n97 Forest"}, "variant": {"add": ["Llanowar Elves"], "cut": ["Forest"]}, "field": top3, "games": 100}));
    let (_, details) = invalid(create(&pool, &bryan, pair, sim.as_ref()).await.unwrap_err());
    assert!(details["problems"]["base"][0].as_str().unwrap().starts_with("two commanders need"), "{details}");
    // Legal-ish: an off-colour card, a banned card and a second copy are warnings, not refusals.
    let d = create(&pool, &bryan, mk(json!({"cut": ["Forest", "Forest", "Forest"], "add": ["Lightning Bolt", "Black Lotus", "Sol Ring"]}), top3.clone(), 100), sim.as_ref()).await.unwrap();
    assert!(d.warnings.iter().any(|w| w.starts_with("Changed list:") && w.contains("color identity")), "{:?}", d.warnings);
    assert!(d.warnings.iter().any(|w| w.contains("Black Lotus is banned")), "{:?}", d.warnings);
    assert!(d.warnings.iter().any(|w| w.contains("2 × Sol Ring: Commander is singleton")), "{:?}", d.warnings);
    delete(&pool, "bryan", &d.item.id).await.unwrap();

    // Fields: too small, unknown precons, unplayable precons, unknown kinds.
    let swap = json!({"cut": ["Forest"], "add": ["Llanowar Elves"]});
    assert!(bad(create(&pool, &bryan, mk(swap.clone(), json!({"kind": "precons_ids", "ids": ["p2", "p3"]}), 100), sim.as_ref()).await.unwrap_err()).contains("at least 3"));
    let (_, details) = invalid(create(&pool, &bryan, mk(swap.clone(), json!({"kind": "precons_ids", "ids": ["p2", "p3", "zzz"]}), 100), sim.as_ref()).await.unwrap_err());
    assert_eq!(details["unknown_precons"], json!(["zzz"]));
    let (_, details) = invalid(create(&pool, &bryan, mk(swap.clone(), json!({"kind": "precons_ids", "ids": ["p2", "p3", "p6"]}), 100), sim.as_ref()).await.unwrap_err());
    assert_eq!(details["unplayable_precons"]["p6"], json!(["Mystery Card"]));
    assert!(bad(create(&pool, &bryan, mk(swap.clone(), json!({"kind": "everyone"}), 100), sim.as_ref()).await.unwrap_err()).contains("field.kind"));
    assert!(bad(create(&pool, &bryan, req(json!({"base": {"kind": "folder"}, "variant": swap, "field": top3, "games": 100})), sim.as_ref()).await.unwrap_err()).contains("base.kind"));
    assert!(bad(create(&pool, &bryan, mk(swap.clone(), json!({"kind": "precons_top", "n": 2}), 100), sim.as_ref()).await.unwrap_err()).contains("field.n"));

    // Games and AI level: fixed choices for users, wider for admins.
    for g in [20, 300, 2000] {
        assert!(bad(create(&pool, &bryan, mk(swap.clone(), top3.clone(), g), sim.as_ref()).await.unwrap_err()).contains("100, 200 or 400"));
    }
    for g in [0, 21, 2002] {
        assert!(bad(create(&pool, &admin, mk(swap.clone(), top3.clone(), g), sim.as_ref()).await.unwrap_err()).contains("even number"));
    }
    let hard = |who: &str| req(json!({"base": {"kind": "precon", "id": "p1"}, "variant": {"cut": ["Forest"], "add": ["Llanowar Elves"]}, "field": {"kind": "precons_top", "n": 3}, "games": 20, "difficulty": who}));
    assert!(bad(create(&pool, &bryan, hard("Hard"), sim.as_ref()).await.unwrap_err()).contains("100, 200 or 400"));
    let d = create(&pool, &admin, hard("hard"), sim.as_ref()).await.unwrap();
    assert_eq!((d.item.label.difficulty.as_str(), d.item.progress.total), ("Hard", 20));
    assert!(bad(create(&pool, &admin, hard("Godlike"), sim.as_ref()).await.unwrap_err()).contains("unknown difficulty"));
    let mut medium = swap_req(100);
    medium.difficulty = Some("Hard".into());
    assert!(bad(create(&pool, &bryan, medium, sim.as_ref()).await.unwrap_err()).contains("Easy or Medium"));
}

#[tokio::test]
async fn fields_from_the_catalog_and_from_your_decks() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let bryan = user("bryan", false);
    let swap = json!({"cut": ["Forest"], "add": ["Llanowar Elves"]});
    let mk = |base: Value, field: Value| req(json!({"base": base, "variant": swap, "field": field, "games": 100}));

    // All precons but the base; the one with a card the engine can't play is left out, with a note.
    let d = create(&pool, &bryan, mk(json!({"kind": "precon", "id": "p1"}), json!({"kind": "precons_all"})), sim.as_ref()).await.unwrap();
    assert_eq!(d.item.field.as_ref().unwrap().label, "All 4 precons");
    assert!(d.warnings.iter().any(|w| w.contains("Left out 1 precons") && w.contains("Precon p6")), "{:?}", d.warnings);
    cancel(&pool, "bryan", &d.item.id).await.unwrap();
    // Nearest in strength to the base precon (p3, 1.0): p4 (0.8), p2 (1.5), p5 (0.5).
    let d = create(&pool, &bryan, mk(json!({"kind": "precon", "id": "p3"}), json!({"kind": "precons_near", "n": 3})), sim.as_ref()).await.unwrap();
    let mut ids: Vec<&str> = d.opponents.iter().map(|o| o.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec!["precons/p2", "precons/p4", "precons/p5"]);
    assert_eq!(d.item.field.as_ref().unwrap().label, "3 precons nearest in strength to Precon p3");
    cancel(&pool, "bryan", &d.item.id).await.unwrap();

    // Your own decks: the base deck and a 98-card deck are left out of an "all my decks" field.
    let base = deck(&pool, "bryan", "Mine", list_of("Ghave", &[])).await;
    let mut short = list_of("Atla", &[]);
    short.last_mut().unwrap().1 = 96;
    let short = deck(&pool, "bryan", "Short", short).await;
    for (name, c) in [("A", "Atla"), ("B", "Bruna"), ("C", "Cadric")] {
        deck(&pool, "bryan", name, list_of(c, &[])).await;
    }
    let d = create(&pool, &bryan, mk(json!({"kind": "deck", "id": base}), json!({"kind": "my_decks"})), sim.as_ref()).await.unwrap();
    assert_eq!(d.item.field.as_ref().unwrap().label, "3 of your decks");
    assert!(d.opponents.iter().all(|o| o.id.starts_with("deck/") && o.id != format!("deck/{base}")));
    assert!(d.warnings.iter().any(|w| w.contains("Short")), "{:?}", d.warnings);
    assert_eq!(d.item.base.as_ref().unwrap().label, "Mine");
    cancel(&pool, "bryan", &d.item.id).await.unwrap();
    // Naming the short deck is refused, saying why.
    let all: Vec<String> = sqlx::query_scalar("SELECT id FROM decks WHERE owner_id = 'bryan' AND id != ?").bind(&base).fetch_all(&pool).await.unwrap();
    let (_, details) = invalid(create(&pool, &bryan, mk(json!({"kind": "deck", "id": base}), json!({"kind": "my_decks", "ids": all})), sim.as_ref()).await.unwrap_err());
    assert!(details["unplayable_decks"][&short]["problems"][0].as_str().unwrap().contains("98 cards"), "{details}");
    // A deck version as the base works too.
    let version: String = sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ?").bind(&base).fetch_one(&pool).await.unwrap();
    let d = create(&pool, &bryan, mk(json!({"kind": "deck_version", "id": version}), json!({"kind": "precons_top", "n": 3})), sim.as_ref()).await.unwrap();
    assert_eq!(d.lists.base.source["version"], json!(version));
}

#[tokio::test]
async fn other_users_experiments_and_decks_are_not_found() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let d = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    let id = d.item.id.clone();
    assert!(list(&pool, "other").await.unwrap().is_empty());
    assert_eq!(list(&pool, "bryan").await.unwrap().len(), 1);
    assert!(matches!(detail(&pool, "other", &id).await, Err(AppError::NotFound(_))));
    assert!(matches!(cancel(&pool, "other", &id).await, Err(AppError::NotFound(_))));
    assert!(matches!(delete(&pool, "other", &id).await, Err(AppError::NotFound(_))));
    assert_eq!(detail(&pool, "bryan", &id).await.unwrap().item.status, "queued");
    // Bryan's deck can't be someone else's base or field.
    let mine = deck(&pool, "bryan", "Mine", list_of("Ghave", &[])).await;
    let other = user("other", false);
    let as_base = req(json!({"base": {"kind": "deck", "id": mine}, "variant": {"cut": ["Forest"], "add": ["Llanowar Elves"]}, "field": {"kind": "precons_top", "n": 3}, "games": 100}));
    assert!(matches!(create(&pool, &other, as_base, sim.as_ref()).await, Err(AppError::NotFound(_))));
    let mut in_field = swap_req(100);
    in_field.field = FieldChoice { kind: "my_decks".into(), n: None, ids: vec![mine.clone()] };
    assert!(matches!(create(&pool, &other, in_field, sim.as_ref()).await, Err(AppError::NotFound(_))));
    // The same op id belongs to each user separately.
    let mut a = swap_req(100);
    a.op_id = Some("op-1".into());
    let mut b = swap_req(100);
    b.op_id = Some("op-1".into());
    let ida = create(&pool, &user("bryan", false), a, sim.as_ref()).await.unwrap().item.id;
    let idb = create(&pool, &other, b, sim.as_ref()).await.unwrap().item.id;
    assert_ne!(ida, idb);
}

#[tokio::test]
async fn limits_per_user_and_retried_creates() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let bryan = user("bryan", false);
    let mut ids = Vec::new();
    for _ in 0..3 {
        ids.push(create(&pool, &bryan, swap_req(100), sim.as_ref()).await.unwrap().item.id);
    }
    // One playing plus two waiting: a fourth is refused until one is cancelled.
    let refused = create(&pool, &bryan, swap_req(100), sim.as_ref()).await.unwrap_err();
    assert!(matches!(&refused, AppError::Conflict(m) if m.contains("one experiment playing and two waiting")), "{refused:?}");
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_experiments").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 3, "the refused one left nothing behind");
    let games: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_experiment_games").fetch_one(&pool).await.unwrap();
    assert_eq!(games, 300);
    assert_eq!(cancel(&pool, "bryan", &ids[0]).await.unwrap().item.status, "cancelled");
    let mut with_op = swap_req(200);
    with_op.op_id = Some("try-1".into());
    let made = create(&pool, &bryan, with_op, sim.as_ref()).await.unwrap();
    // The same op id again returns the same experiment, even though the limit is now reached.
    let mut again = swap_req(400);
    again.op_id = Some("try-1".into());
    let again = create(&pool, &bryan, again, sim.as_ref()).await.unwrap();
    assert_eq!((again.item.id.as_str(), again.item.progress.total), (made.item.id.as_str(), 200));
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_experiments WHERE owner_id = 'bryan'").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 4);
    // Admins aren't limited.
    let admin = user("admin", true);
    for _ in 0..4 {
        create(&pool, &admin, swap_req(100), sim.as_ref()).await.unwrap();
    }
}

#[tokio::test]
async fn the_worker_plays_both_lists_on_the_same_pods_and_summarizes() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let d = create(&pool, &user("bryan", false), swap_req(200), sim.as_ref()).await.unwrap();
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    let played = sim.played();
    assert_eq!(played.len(), 200);
    // Each game got the lists its schedule line names, seat by seat.
    for (spec, decks) in &played {
        assert_eq!(&spec.decks, decks);
    }
    let by_game: HashMap<&str, &GameSpec> = played.iter().map(|(s, _)| (s.game.as_str(), s)).collect();
    for t in 0..100 {
        let b = by_game[format!("{}-{t}-base", &d.item.id[..8]).as_str()];
        let v = by_game[format!("{}-{t}-variant", &d.item.id[..8]).as_str()];
        assert_eq!(b.seed, v.seed);
        assert_eq!(b.decks.iter().filter(|x| x.starts_with("precons/")).collect::<Vec<_>>(), v.decks.iter().filter(|x| x.starts_with("precons/")).collect::<Vec<_>>());
    }
    let done = detail(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!((done.item.status.as_str(), done.item.progress.done), ("done", 200));
    assert!(done.item.label.finished_at.is_some() && done.item.label.started_at.is_some());
    assert_eq!(done.item.progress.eta_seconds, None);
    let s = done.item.summary.unwrap();
    assert_eq!((s.pods, s.paired.pods, s.paired.base_only), (100, 100, 0));
    assert!(s.paired.variant_only > 0);
    assert_eq!(s.variant.wins, s.base.wins + s.paired.variant_only);
    assert_eq!(s.verdict.kind, VerdictKind::Better, "{}", s.verdict.text);
    assert!(s.verdict.is_final && s.verdict.text.starts_with("Probably better (+"));
    assert_eq!(s.unscored.total, 0);
    let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_experiment_games WHERE result IS NOT NULL AND end_kind = 'win' AND finished_at IS NOT NULL")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored, 200);
    // Storing a result again changes nothing.
    let (spec, decks) = &played[0];
    let line: String = sqlx::query_scalar("SELECT result FROM lab_experiment_games WHERE game = ?").bind(&spec.game).fetch_one(&pool).await.unwrap();
    let mut other = sim.play(spec, &decks.iter().map(|id| Arc::new(LabList { id: id.clone(), label: String::new(), source: Value::Null, sha256: String::new(), cards: vec![] })).collect::<Vec<_>>(), &LIMITS);
    other.turns = 99;
    assert!(!store(&pool, &d.item.id, &spec.game, &other).await.unwrap());
    let after: String = sqlx::query_scalar("SELECT result FROM lab_experiment_games WHERE game = ?").bind(&spec.game).fetch_one(&pool).await.unwrap();
    assert_eq!(after, line);
}

#[tokio::test]
async fn first_in_first_out_with_one_experiment_at_a_time_per_user() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let bryan = user("bryan", false);
    let a1 = create(&pool, &bryan, swap_req(100), sim.as_ref()).await.unwrap().item.id;
    let a2 = create(&pool, &bryan, swap_req(100), sim.as_ref()).await.unwrap().item.id;
    let b1 = create(&pool, &user("other", false), swap_req(100), sim.as_ref()).await.unwrap().item.id;
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    let next = |n: usize| {
        let w = worker.clone();
        async move { w.next_jobs(n).await.unwrap().into_iter().map(|j| (j.experiment, j.game)).collect::<Vec<_>>() }
    };
    // Oldest first: both threads take Bryan's first experiment, in play order.
    let jobs = next(2).await;
    assert_eq!(jobs.iter().map(|j| j.0.as_str()).collect::<Vec<_>>(), vec![a1.as_str(), a1.as_str()]);
    assert!(jobs[0].1.ends_with("-0-base") && jobs[1].1.ends_with("-0-variant"));
    // When it has one game left, the free thread goes to the other user, not to Bryan's second.
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT game, spec FROM lab_experiment_games WHERE experiment_id = ? ORDER BY ord").bind(&a1).fetch_all(&pool).await.unwrap();
    for (game, spec) in &rows[..99] {
        let spec: GameSpec = serde_json::from_str(spec).unwrap();
        assert!(store(&pool, &a1, game, &sim.play(&spec, &[], &LIMITS)).await.unwrap());
    }
    let jobs = next(2).await;
    assert_eq!(jobs.iter().map(|j| j.0.as_str()).collect::<Vec<_>>(), vec![a1.as_str(), b1.as_str()]);
    // Once it's done, Bryan's second is older than the other user's, so it goes first.
    let (game, spec) = &rows[99];
    assert!(store(&pool, &a1, game, &sim.play(&serde_json::from_str(spec).unwrap(), &[], &LIMITS)).await.unwrap());
    assert_eq!(detail(&pool, "bryan", &a1).await.unwrap().item.status, "done");
    let jobs = next(3).await;
    assert_eq!(jobs.iter().map(|j| j.0.as_str()).collect::<Vec<_>>(), vec![a2.as_str(), a2.as_str(), a2.as_str()]);
    // An admin's experiments all run side by side.
    let admin = user("admin", true);
    let c1 = create(&pool, &admin, swap_req(4), sim.as_ref()).await;
    assert!(c1.is_ok());
    let c2 = create(&pool, &admin, swap_req(4), sim.as_ref()).await.unwrap().item.id;
    let c1 = c1.unwrap().item.id;
    sqlx::query("UPDATE lab_experiments SET status = 'cancelled' WHERE id IN (?, ?)").bind(&a2).bind(&b1).execute(&pool).await.unwrap();
    let jobs = next(8).await;
    let exps: HashSet<&str> = jobs.iter().map(|j| j.0.as_str()).collect();
    assert_eq!(exps, HashSet::from([c1.as_str(), c2.as_str()]));
    assert_eq!(jobs.len(), 8);
}

#[tokio::test]
async fn a_restarted_server_resumes_without_replaying_stored_games() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let d = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    // The first server stored 37 games, then stopped with others in flight (no result yet).
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT game, spec FROM lab_experiment_games WHERE experiment_id = ? ORDER BY ord").bind(&d.item.id).fetch_all(&pool).await.unwrap();
    for (game, spec) in &rows[..37] {
        assert!(store(&pool, &d.item.id, game, &sim.play(&serde_json::from_str(spec).unwrap(), &[], &LIMITS)).await.unwrap());
    }
    sqlx::query("UPDATE lab_experiments SET status = 'running', started_at = 'earlier' WHERE id = ?").bind(&d.item.id).execute(&pool).await.unwrap();
    let before: Vec<(String, String)> = sqlx::query_as("SELECT game, result FROM lab_experiment_games WHERE result IS NOT NULL ORDER BY game").fetch_all(&pool).await.unwrap();
    let partial = detail(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!(partial.item.progress.done, 37);
    let s = partial.item.summary.unwrap();
    assert!(!s.verdict.is_final);
    assert_eq!(s.base.pending + s.variant.pending, 63);

    // A new server with a new worker plays only the 63 games without a result.
    let fresh = FakeSim::new();
    let worker = LabWorker::new(pool.clone(), 3, SimState::Ready(fresh.clone()));
    worker.drain().await;
    let replayed: HashSet<String> = fresh.played().into_iter().map(|(s, _)| s.game).collect();
    let expected: HashSet<String> = rows[37..].iter().map(|(g, _)| g.clone()).collect();
    assert_eq!(replayed, expected);
    assert_eq!(fresh.played().len(), 63, "no game played twice");
    let kept: Vec<(String, String)> =
        sqlx::query_as("SELECT game, result FROM lab_experiment_games WHERE game IN (SELECT value FROM json_each(?)) ORDER BY game")
            .bind(json!(before.iter().map(|b| &b.0).collect::<Vec<_>>()).to_string())
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(kept, before, "stored results are untouched");
    let done = detail(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!((done.item.status.as_str(), done.item.progress.done), ("done", 100));
    assert_eq!(done.item.label.started_at.as_deref(), Some("earlier"));
}

#[tokio::test]
async fn cancelled_and_deleted_experiments_stop_and_failures_are_reported() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let bryan = user("bryan", false);
    let d = create(&pool, &bryan, swap_req(100), sim.as_ref()).await.unwrap();
    let c = cancel(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!(c.item.status, "cancelled");
    assert!(c.item.label.finished_at.is_some());
    assert!(c.item.summary.as_ref().unwrap().verdict.is_final);
    assert_eq!(cancel(&pool, "bryan", &d.item.id).await.unwrap().item.status, "cancelled");
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    assert!(sim.played().is_empty(), "a cancelled experiment plays nothing more");

    // A result for a deleted experiment is dropped.
    let gone = create(&pool, &bryan, swap_req(100), sim.as_ref()).await.unwrap();
    let (game, spec): (String, String) =
        sqlx::query_as("SELECT game, spec FROM lab_experiment_games WHERE experiment_id = ? LIMIT 1").bind(&gone.item.id).fetch_one(&pool).await.unwrap();
    delete(&pool, "bryan", &gone.item.id).await.unwrap();
    assert!(matches!(delete(&pool, "bryan", &gone.item.id).await, Err(AppError::NotFound(_))));
    assert!(!store(&pool, &gone.item.id, &game, &sim.play(&serde_json::from_str(&spec).unwrap(), &[], &LIMITS)).await.unwrap());
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_experiment_games WHERE experiment_id = ?").bind(&gone.item.id).fetch_one(&pool).await.unwrap();
    assert_eq!(left, 0);

    // Cancelling a finished experiment leaves it done.
    let finished = create(&pool, &bryan, swap_req(100), sim.as_ref()).await.unwrap();
    worker.drain().await;
    assert_eq!(cancel(&pool, "bryan", &finished.item.id).await.unwrap().item.status, "done");

    // Every game failing: the experiment fails and says why.
    let failing = Arc::new(FakeSim { fail: true, ..Default::default() });
    let f = create(&pool, &bryan, swap_req(100), failing.as_ref()).await.unwrap();
    LabWorker::new(pool.clone(), 2, SimState::Ready(failing.clone())).drain().await;
    let f = detail(&pool, "bryan", &f.item.id).await.unwrap();
    assert_eq!(f.item.status, "failed");
    assert!(f.item.error.as_deref().unwrap().contains("engine refused everything"), "{:?}", f.item.error);
    assert_eq!(f.item.summary.unwrap().unscored.error, 100);
}

#[tokio::test]
async fn without_engine_card_data_experiments_are_unavailable() {
    let pool = fixture().await;
    let missing = LabWorker::new(pool.clone(), 2, SimState::Missing(NO_CARD_DATA.into()));
    for e in [missing.check_available().unwrap_err(), missing.simulator().err().unwrap()] {
        assert!(matches!(&e, AppError::Unavailable(m) if m == NO_CARD_DATA));
        let response = e.into_response();
        assert_eq!(response.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(response.into_body(), 1 << 16).await.unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), json!({"error": NO_CARD_DATA}));
    }
    // Still loading: experiments can be read, not started.
    let starting = LabWorker::new(pool.clone(), 2, SimState::Starting);
    assert!(starting.check_available().is_ok());
    assert!(matches!(starting.simulator(), Err(AppError::Unavailable(m)) if m.contains("still starting")));
    // The lab turned off: readable, not startable.
    let off = LabWorker::new(pool.clone(), 0, SimState::Ready(FakeSim::new()));
    assert!(off.check_available().is_ok());
    assert!(matches!(off.simulator(), Err(AppError::Unavailable(m)) if m.contains("YAMA_LAB_THREADS")));
    // A 400 with details carries them beside the message.
    let response = AppError::Invalid { message: "nope".into(), details: json!({"unknown": {"base": ["X"]}, "error": "ignored"}) }.into_response();
    assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(response.into_body(), 1 << 16).await.unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), json!({"error": "nope", "unknown": {"base": ["X"]}}));
}

#[test]
fn the_deck_checks_block_only_on_size_and_commanders() {
    let info: HashMap<String, crate::cards::Card> = HashMap::new();
    // No card info: validate warns about each card but the size and commander rules still apply.
    let cards = |commander: bool, n: u32| vec![LabCard { name: "X".into(), oracle_id: None, qty: 1, commander }, LabCard { name: "Forest".into(), oracle_id: None, qty: n, commander: false }];
    assert!(check_list(&cards(true, 99), &info).blocking.is_empty());
    let c = check_list(&cards(false, 99), &info);
    assert!(c.blocking.iter().any(|e| e.contains("no commander")), "{:?}", c.blocking);
    let c = check_list(&cards(true, 97), &info);
    assert!(c.blocking.iter().any(|e| e.contains("98 cards")), "{:?}", c.blocking);
    assert!(c.warnings.iter().any(|w| w.contains("isn't in the card data")));
    let three: Vec<LabCard> = ["A", "B", "C"].iter().map(|n| LabCard { name: n.to_string(), oracle_id: None, qty: 1, commander: true }).chain(cards(false, 97)).collect();
    let c = check_list(&three, &info);
    assert!(c.blocking.iter().any(|e| e == "3 commanders; the most is two"), "{:?}", c.blocking);
    // A card whose name has "commander" in it doesn't turn a warning into a refusal.
    let named = vec![LabCard { name: "X".into(), oracle_id: None, qty: 1, commander: true }, LabCard { name: "Siege-Gang Commander".into(), oracle_id: None, qty: 99, commander: false }];
    assert!(check_list(&named, &info).blocking.is_empty());
    // Changes apply one copy per entry, merge and sort.
    let base = vec![
        LabCard { name: "Ghave".into(), oracle_id: Some("g".into()), qty: 1, commander: true },
        LabCard { name: "Forest".into(), oracle_id: Some("f".into()), qty: 2, commander: false },
    ];
    let out = apply_change(&base, &[("s".into(), "Sol Ring".into())], &[("f".into(), "Forest".into())]).unwrap();
    assert_eq!(out.iter().map(|c| (c.name.as_str(), c.qty, c.commander)).collect::<Vec<_>>(), vec![("Ghave", 1, true), ("Forest", 1, false), ("Sol Ring", 1, false)]);
    assert!(apply_change(&base, &[], &vec![("f".to_string(), "Forest".to_string()); 3]).is_err());
    let (added, cut) = diff(&base, &out);
    assert_eq!((added[0].name.as_str(), cut[0].name.as_str(), cut[0].qty), ("Sol Ring", "Forest", 1));
}

#[tokio::test]
async fn a_game_that_keeps_stopping_the_server_is_written_off_not_replayed() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let d = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    // Pod 0's base game was started twice and the server stopped both times (a crash inside the
    // game, say); its changed-list game was in flight during one ordinary restart.
    let games: Vec<String> =
        sqlx::query_scalar("SELECT game FROM lab_experiment_games WHERE experiment_id = ? ORDER BY ord").bind(&d.item.id).fetch_all(&pool).await.unwrap();
    sqlx::query("UPDATE lab_experiment_games SET attempts = ? WHERE game = ?").bind(MAX_ATTEMPTS).bind(&games[0]).execute(&pool).await.unwrap();
    sqlx::query("UPDATE lab_experiment_games SET attempts = 1 WHERE game = ?").bind(&games[1]).execute(&pool).await.unwrap();
    LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone())).drain().await;

    let played: HashSet<String> = sim.played().into_iter().map(|(s, _)| s.game).collect();
    assert!(!played.contains(&games[0]), "the game that kept stopping the server isn't played again");
    assert!(played.contains(&games[1]));
    assert_eq!(played.len(), 99);
    let (end, result): (String, String) =
        sqlx::query_as("SELECT end_kind, result FROM lab_experiment_games WHERE game = ?").bind(&games[0]).fetch_one(&pool).await.unwrap();
    assert_eq!(end, "error");
    let r: GameResult = serde_json::from_str(&result).unwrap();
    assert!(r.error.as_deref().unwrap().starts_with("written off without playing it again"), "{:?}", r.error);
    // Every start is counted once, before the game plays.
    let attempts: Vec<i64> =
        sqlx::query_scalar("SELECT attempts FROM lab_experiment_games WHERE experiment_id = ? ORDER BY ord").bind(&d.item.id).fetch_all(&pool).await.unwrap();
    assert_eq!((attempts[0], attempts[1]), (MAX_ATTEMPTS, 2));
    assert!(attempts[2..].iter().all(|a| *a == 1), "{attempts:?}");
    // It counts as an unscored error, and its pod drops out of the paired difference.
    let done = detail(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!(done.item.status, "done");
    let s = done.item.summary.unwrap();
    assert_eq!((s.unscored.error, s.paired.pods, s.base.games, s.variant.games), (1, 49, 49, 50));
}

#[tokio::test]
async fn hung_threads_take_places_and_games_keep_their_frozen_limits() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let first = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap().item.id;
    let second = create(&pool, &user("other", false), swap_req(100), sim.as_ref()).await.unwrap().item.id;
    // The first experiment was made when the loop guard was 123 actions: its games keep that.
    sqlx::query("UPDATE lab_experiments SET spec = json_set(spec, '$.limits.turn_action_cap', 123) WHERE id = ?").bind(&first).execute(&pool).await.unwrap();
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    // Both places held by hung threads: nothing starts. One freed: one game at a time.
    sim.stuck.store(2, Ordering::SeqCst);
    assert_eq!(worker.tick().await.unwrap(), 0);
    sim.stuck.store(1, Ordering::SeqCst);
    assert_eq!(worker.tick().await.unwrap(), 1);
    sim.stuck.store(0, Ordering::SeqCst);
    worker.drain().await;
    let caps = sim.loop_caps.lock().unwrap().clone();
    assert_eq!(caps.len(), 200);
    assert_eq!(caps.iter().filter(|c| **c == 123).count(), 100);
    assert_eq!(caps.iter().filter(|c| **c == MAX_TURN_ACTIONS).count(), 100);
    for id in [&first, &second] {
        let owner: String = sqlx::query_scalar("SELECT owner_id FROM lab_experiments WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(detail(&pool, &owner, id).await.unwrap().item.status, "done");
    }
    assert_eq!(LIMITS.turn_action_cap, MAX_TURN_ACTIONS);
}
