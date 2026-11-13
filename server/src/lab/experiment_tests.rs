//! "Try a change" end to end against an in-memory database, with a fake simulator so the worker's
//! games take microseconds: validation, isolation, limits, pairing, the worker's order, resuming
//! after a restart, cancelling and deleting, and the 503 without engine card data.

use super::experiments::*;
use super::forge::ForgeAccess;
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
use yama_play::lab::{ENGINE, End, GameResult, GameSpec, MAX_TURN_ACTIONS};

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
        let n = spec.decks.len() as u8;
        let roll = spec.seed % 10;
        let winner = match spec.decks.iter().position(|d| d == BASE_ID || d == VARIANT_ID) {
            Some(seat) => {
                let seat = seat as u8;
                let wins = roll < 2 || (spec.decks[seat as usize] == VARIANT_ID && roll < 4);
                if wins { seat } else { (seat + 1) % n }
            }
            // Head to head: "e0" wins about 8 games in 10, "e1" the rest when it's there, else a filler.
            None => {
                let at = |id: &str| spec.decks.iter().position(|d| d == id).map(|s| s as u8);
                match (at("e0"), at("e1")) {
                    (Some(a), _) if roll < 8 => a,
                    (_, Some(b)) => b,
                    _ => (0..n).find(|s| !spec.decks[*s as usize].starts_with('e')).unwrap_or(0),
                }
            }
        };
        r.end = End::Win;
        r.winner = Some(winner);
        r.first_seat = Some(0);
        r.placements = vec![vec![winner], (0..n).filter(|s| *s != winner).collect()];
        r.turns = 9;
        r
    }
}

/// The seed the tests that assert a simulated verdict create their run with (`test_seed`).
const VERDICT_SEED: u64 = 4;

/// For cancel: no game of any experiment is playing.
fn idle(_: &str) -> bool {
    false
}

fn user(id: &str, admin: bool) -> User {
    User { id: id.into(), email: format!("{id}@example.com"), display_name: id.into(), is_admin: admin, limited: false, power: true, guest: false }
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
    seed(&pool).await;
    pool
}

/// The fixture's users, cards, precons and ratings, in any database.
async fn seed(pool: &SqlitePool) {
    let pool = pool.clone();
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
    assert_eq!((d.item.label.engine.as_str(), d.item.label.card_data.as_str(), d.item.label.difficulty.as_str()), (ENGINE, "fakecarddata0000", "Easy"));
    assert!(d.item.label.simulated);
    assert_eq!(d.lists.base.cards.iter().map(|c| c.qty).sum::<u32>(), 100);
    assert_eq!(d.lists.variant.as_ref().unwrap().cards.iter().map(|c| c.qty).sum::<u32>(), 100);
    assert_ne!(d.lists.base.sha256, d.lists.variant.as_ref().unwrap().sha256);
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

/// Every account may start a run (12 Nov 2026). One that isn't a power user gets the short
/// allowance: one 20-game run on Phase in 24 hours, one at a time.
#[tokio::test]
async fn an_account_that_isnt_a_power_user_runs_one_short_simulation_a_day() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let quota = crate::config::LabQuota::default();
    let fa = ForgeAccess::default();
    // Invited or signed up with Google, it is the same allowance.
    let pat = User { power: false, ..user("bryan", false) };
    let newbie = User { power: false, ..add_open_user(&pool, "newbie").await };
    for u in [&pat, &newbie] {
        assert_eq!((tier(u), game_choices(u), caps(u, &quota)), (Tier::Short, &[SHORT_GAMES][..], (Some(1), Some(20))));
    }
    assert_eq!(tier(&user("bryan", false)), Tier::Full);
    assert_eq!(tier(&User { limited: true, ..user("bryan", false) }), Tier::Standard);
    assert_eq!(tier(&user("admin", true)), Tier::Admin);

    // The size is fixed, and the refusal says what it is, not how the account joined.
    for g in [2, 100, 200, 400] {
        let e = bad(create_with(&pool, &pat, swap_req(g), sim.as_ref(), &quota, &fa).await.unwrap_err());
        assert!(e.contains("games must be 20") && e.contains("one short simulation a day") && e.contains("About page") && !e.contains("invite"), "{e}");
    }
    // Phase only: Forge stays with power users, and its worker is never asked.
    let forge = FakeForge::new(&[]);
    for engine in ["forge", "both"] {
        let e = bad(create_with(&pool, &pat, with_engine(swap_req(20), engine), sim.as_ref(), &quota, &forge_access(&forge)).await.unwrap_err());
        assert!(e.contains("Phase only"), "{e}");
    }
    assert_eq!(forge.checked.load(Ordering::SeqCst), 0);
    assert!(bad(create_with(&pool, &pat, req(json!({"base": {"kind": "precon", "id": "p1"}, "variant": {"cut": ["Forest"], "add": ["Sol Ring"]}, "field": {"kind": "precons_top", "n": 3}, "games": 20, "difficulty": "Hard"})), sim.as_ref(), &quota, &fa).await.unwrap_err()).contains("Easy or Medium"));

    // The day's run: 10 pods, each played by both lists.
    let with_op = |op: &str| {
        let mut r = swap_req(20);
        r.op_id = Some(op.into());
        r
    };
    let first = create_with(&pool, &pat, with_op("op-1"), sim.as_ref(), &quota, &fa).await.unwrap();
    assert_eq!((first.item.progress.total, first.item.status.as_str()), (20, "queued"));
    // A retry of the same request answers with the run; a new one waits for it to finish.
    assert_eq!(create_with(&pool, &pat, with_op("op-1"), sim.as_ref(), &quota, &fa).await.unwrap().item.id, first.item.id);
    let e = create_with(&pool, &pat, with_op("op-2"), sim.as_ref(), &quota, &fa).await.unwrap_err();
    assert!(matches!(&e, AppError::Conflict(m) if m.contains("one experiment at a time")), "{e:?}");
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    let done = detail(&pool, "bryan", &first.item.id).await.unwrap();
    assert_eq!((done.item.status.as_str(), done.item.summary.as_ref().map(|s| s.paired.pods)), ("done", Some(10)));

    // That was today's: a new run, the same run again and more games on it are all refused, and
    // the refusal says the limit and what was used.
    let used_up = |e: AppError| matches!(&e, AppError::Conflict(m) if m.contains("20 games a day") && m.contains("asked for 20") && m.contains("About page") && !m.contains("invite"));
    assert!(used_up(create_with(&pool, &pat, with_op("op-2"), sim.as_ref(), &quota, &fa).await.unwrap_err()));
    assert!(used_up(again_with(&pool, &pat, &first.item.id, 20, None, sim.as_ref(), &quota, &fa).await.unwrap_err()));
    assert!(used_up(more_with(&pool, &pat, &first.item.id, 20, 10, sim.as_ref(), &quota, &fa).await.unwrap_err()));
    // A request about pods the run doesn't have is a retry or a stale page: it answers with the run.
    assert_eq!(more_with(&pool, &pat, &first.item.id, 20, 0, sim.as_ref(), &quota, &fa).await.unwrap().item.id, first.item.id);
    let runs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_experiments WHERE owner_id = 'bryan'").fetch_one(&pool).await.unwrap();
    assert_eq!(runs, 1, "refused runs leave nothing behind");
    // The Try page hears what it may offer and what is left, and no Forge.
    let p = pace(&pool, &pat, 2, Ok(())).await.unwrap();
    assert_eq!(p.game_choices, vec![20]);
    assert_eq!(allowance(&pool, &pat, &quota).await.unwrap(), Some(Allowance { games: 20, at_a_time: 1, games_per_day: 20, used_today: 20 }));
    // Another account's day is its own.
    create_with(&pool, &newbie, swap_req(20), sim.as_ref(), &quota, &fa).await.unwrap();

    // The next day: more games on the finished run, then that day is used too.
    sqlx::query("UPDATE lab_usage SET created_at = '2026-01-01T00:00:00Z' WHERE owner_id = 'bryan'").execute(&pool).await.unwrap();
    let more = more_with(&pool, &pat, &first.item.id, 20, 10, sim.as_ref(), &quota, &fa).await.unwrap();
    assert_eq!(more.item.progress.total, 40);
    worker.drain().await;
    assert!(used_up(again_with(&pool, &pat, &first.item.id, 20, None, sim.as_ref(), &quota, &fa).await.unwrap_err()));
    // Deleting the run doesn't hand the day back.
    delete(&pool, "bryan", &first.item.id).await.unwrap();
    assert!(used_up(create_with(&pool, &pat, with_op("op-3"), sim.as_ref(), &quota, &fa).await.unwrap_err()));

    // A power user's run from before the account lost the grant is still theirs to read, and the
    // short allowance is what they may start now.
    let big = create(&pool, &user("other", false), swap_req(100), sim.as_ref()).await.unwrap();
    let other = User { power: false, ..user("other", false) };
    assert_eq!(detail(&pool, "other", &big.item.id).await.unwrap().item.id, big.item.id);
    assert!(bad(again_with(&pool, &other, &big.item.id, 100, None, sim.as_ref(), &quota, &fa).await.unwrap_err()).contains("games must be 20"));

    // A server that gives these accounts no games (YAMA_LAB_SHORT_DAILY_GAMES=0) refuses them as
    // it did before 12 Nov 2026; power users are untouched.
    let off = crate::config::LabQuota { short_daily_games: 0, ..Default::default() };
    let kim = User { power: false, ..user("admin", false) };
    let e = create_with(&pool, &kim, swap_req(20), sim.as_ref(), &off, &fa).await.unwrap_err();
    assert!(matches!(&e, AppError::Forbidden(m) if m == NO_SHORT_RUNS), "{e:?}");
    assert!(!may_start(&kim, &off) && may_start(&kim, &quota) && may_start(&user("bryan", false), &off));
    assert!(allowance(&pool, &kim, &off).await.unwrap().is_some_and(|a| a.games_per_day == 0));
}

/// The short run costs lab time, so its daily count has to hold when requests arrive together:
/// the allowance is checked again in the transaction that stores the run, after the write lock.
/// Twelve requests at once, three times: one run, none once the day is used, one on a new day.
async fn daily_short_run_holds(pool: &SqlitePool) {
    let sim = FakeSim::new();
    let quota = crate::config::LabQuota::default();
    let fa = ForgeAccess::default();
    let pat = User { power: false, ..user("bryan", false) };
    let started = futures_util::future::join_all((0..12).map(|_| create_with(pool, &pat, swap_req(20), sim.as_ref(), &quota, &fa))).await;
    let ok = started.iter().filter(|r| r.is_ok()).count();
    assert_eq!(ok, 1, "one run, however many are asked for at once");
    // Every other request hears a limit; none fails on the database being busy.
    for refused in started.into_iter().filter_map(Result::err) {
        assert!(matches!(&refused, AppError::Conflict(m) if m.contains("one experiment at a time") || m.contains("20 games a day")), "{refused:?}");
    }
    let (runs, games, charged): (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM lab_experiments WHERE owner_id = 'bryan'), (SELECT COUNT(*) FROM lab_experiment_games),
                (SELECT COALESCE(SUM(games), 0) FROM lab_usage WHERE owner_id = 'bryan')",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!((runs, games, charged), (1, 20, 20), "the refused requests stored and charged nothing");

    // With the run finished the at-a-time rule no longer stands in the way, so only the day's
    // count can refuse: again, together.
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    let again = futures_util::future::join_all((0..12).map(|_| create_with(pool, &pat, swap_req(20), sim.as_ref(), &quota, &fa))).await;
    assert!(again.iter().all(|r| matches!(r, Err(AppError::Conflict(m)) if m.contains("20 games a day"))), "the day is used");
    // A new day, together: one run again.
    sqlx::query("UPDATE lab_usage SET created_at = '2026-01-01T00:00:00Z'").execute(pool).await.unwrap();
    let next = futures_util::future::join_all((0..12).map(|_| create_with(pool, &pat, swap_req(20), sim.as_ref(), &quota, &fa))).await;
    assert_eq!(next.iter().filter(|r| r.is_ok()).count(), 1);
    let charged: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(games), 0) FROM lab_usage WHERE owner_id = 'bryan'").fetch_one(pool).await.unwrap();
    assert_eq!(charged, 40);
}

/// On the tests' one connection: the requests take turns at it, so this is the order of the
/// checks and the charge.
#[tokio::test]
async fn the_daily_short_run_holds_when_requests_arrive_together() {
    daily_short_run_holds(&fixture().await).await;
}

/// As production runs it (`db::connect`): a database file in WAL mode and eight connections, on
/// several threads, so the requests really race for SQLite's write lock.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_daily_short_run_holds_across_database_connections() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", dir.path().join("lab.db").display());
    let pool = crate::db::connect(&url, std::time::Duration::from_secs(60)).await.unwrap();
    seed(&pool).await;
    daily_short_run_holds(&pool).await;
    pool.close().await;
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

    // Fields: a pick too small for a pod is topped up (the picked precons in every pod), unknown
    // precons, unplayable precons, unknown kinds.
    let swap = json!({"cut": ["Forest"], "add": ["Llanowar Elves"]});
    let small = create(&pool, &bryan, mk(swap.clone(), json!({"kind": "precons_ids", "ids": ["p2", "p3"]}), 100), sim.as_ref()).await.unwrap();
    let f = small.item.field.clone().unwrap();
    assert_eq!(f.every_pod, 2, "{f:?}");
    assert!(f.label.starts_with("Precon p2 and Precon p3 in every pod, with "), "{}", f.label);
    assert_eq!(small.opponents.iter().filter(|o| o.pods == 50).map(|o| o.id.as_str()).collect::<Vec<_>>(), ["precons/p2", "precons/p3"]);
    assert!(small.opponents.iter().all(|o| o.id != "precons/p1" && o.id != "precons/p6"), "never the base or an unplayable precon");
    delete(&pool, "bryan", &small.item.id).await.unwrap();
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
    cancel(&pool, "bryan", &d.item.id, &idle).await.unwrap();
    // Nearest in strength to the base precon (p3, 1.0): p4 (0.8), p2 (1.5), p5 (0.5).
    let d = create(&pool, &bryan, mk(json!({"kind": "precon", "id": "p3"}), json!({"kind": "precons_near", "n": 3})), sim.as_ref()).await.unwrap();
    let mut ids: Vec<&str> = d.opponents.iter().map(|o| o.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec!["precons/p2", "precons/p4", "precons/p5"]);
    assert_eq!(d.item.field.as_ref().unwrap().label, "3 precons nearest in strength to Precon p3");
    cancel(&pool, "bryan", &d.item.id, &idle).await.unwrap();

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
    cancel(&pool, "bryan", &d.item.id, &idle).await.unwrap();
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
    assert!(list(&pool, "other", &ListPage::default()).await.unwrap().is_empty());
    assert_eq!(list(&pool, "bryan", &ListPage::default()).await.unwrap().len(), 1);
    assert!(matches!(detail(&pool, "other", &id).await, Err(AppError::NotFound(_))));
    assert!(matches!(cancel(&pool, "other", &id, &idle).await, Err(AppError::NotFound(_))));
    assert!(matches!(delete(&pool, "other", &id).await, Err(AppError::NotFound(_))));
    assert_eq!(detail(&pool, "bryan", &id).await.unwrap().item.status, "queued");
    // Bryan's deck can't be someone else's base or field.
    let mine = deck(&pool, "bryan", "Mine", list_of("Ghave", &[])).await;
    let other = user("other", false);
    let as_base = req(json!({"base": {"kind": "deck", "id": mine}, "variant": {"cut": ["Forest"], "add": ["Llanowar Elves"]}, "field": {"kind": "precons_top", "n": 3}, "games": 100}));
    assert!(matches!(create(&pool, &other, as_base, sim.as_ref()).await, Err(AppError::NotFound(_))));
    let mut in_field = swap_req(100);
    in_field.field = Some(FieldChoice { kind: "my_decks".into(), n: None, ids: vec![mine.clone()], fill: None });
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
    assert_eq!(cancel(&pool, "bryan", &ids[0], &idle).await.unwrap().item.status, "cancelled");
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
    // A named seed, so the verdict below is the same every run: of its 100 pods the fake sim
    // gives the changed list alone 21 (`FakeSim::play`, pod seed % 10 of 2 or 3).
    super::experiments::test_seed::set(VERDICT_SEED);
    let d = create(&pool, &user("bryan", false), swap_req(200), sim.as_ref()).await.unwrap();
    assert_eq!(d.seed, VERDICT_SEED);
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
    let mut other = sim.play(spec, &decks.iter().map(|id| Arc::new(LabList { id: id.clone(), label: String::new(), source: Value::Null, sha256: String::new(), cards: vec![], combos: vec![] })).collect::<Vec<_>>(), &LIMITS);
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
    // Progress counts every stored game; the summary is rewritten in batches, so it can be behind
    // until the next start brings it up to date.
    assert_eq!(detail(&pool, "bryan", &d.item.id).await.unwrap().item.progress.done, 37);
    LabWorker::new(pool.clone(), 0, SimState::Ready(FakeSim::new())).catch_up().await.unwrap();
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
    let c = cancel(&pool, "bryan", &d.item.id, &idle).await.unwrap();
    assert_eq!(c.item.status, "cancelled");
    assert!(c.item.label.finished_at.is_some());
    assert!(c.item.summary.as_ref().unwrap().verdict.is_final);
    assert_eq!(cancel(&pool, "bryan", &d.item.id, &idle).await.unwrap().item.status, "cancelled");
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
    assert_eq!(cancel(&pool, "bryan", &finished.item.id, &idle).await.unwrap().item.status, "done");

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

// ── review fixes (experiments step) ─────────────────────────────────────────

/// Holds every game until `open` is set, then plays it as [`FakeSim`] does: games stay in flight
/// for as long as a test needs.
struct GateSim {
    open: std::sync::atomic::AtomicBool,
    inner: Arc<FakeSim>,
}

impl GateSim {
    fn new() -> Arc<Self> {
        Arc::new(GateSim { open: Default::default(), inner: FakeSim::new() })
    }
}

impl Simulator for GateSim {
    fn card_data(&self) -> String {
        self.inner.card_data()
    }
    fn unknown(&self, cards: &[LabCard]) -> Vec<String> {
        self.inner.unknown(cards)
    }
    fn play(&self, spec: &GameSpec, decks: &[Arc<LabList>], limits: &Limits) -> GameResult {
        while !self.open.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        self.inner.play(spec, decks, limits)
    }
}

async fn stored_summary(pool: &SqlitePool, id: &str) -> (i64, Value) {
    let (done, summary): (i64, String) = sqlx::query_as("SELECT games_done, summary FROM lab_experiments WHERE id = ?").bind(id).fetch_one(pool).await.unwrap();
    (done, serde_json::from_str(&summary).unwrap())
}

#[tokio::test]
async fn a_cancelled_summary_is_final_only_once_its_games_in_flight_are_in() {
    let pool = fixture().await;
    let sim = GateSim::new();
    let d = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    assert_eq!(worker.tick().await.unwrap(), 2);
    assert!(worker.playing(&d.item.id));
    // Cancelled with two games playing: they still count, so the summary isn't final yet.
    let c = cancel(&pool, "bryan", &d.item.id, &|e: &str| worker.playing(e)).await.unwrap();
    assert_eq!(c.item.status, "cancelled");
    assert!(!c.item.summary.as_ref().unwrap().verdict.is_final);
    sim.open.store(true, Ordering::SeqCst);
    worker.drain().await;
    let (done, summary) = stored_summary(&pool, &d.item.id).await;
    assert_eq!(done, 2, "the games in flight were kept");
    assert_eq!(summary["verdict"]["final"], json!(true), "final once the last one was in");
    assert_eq!(summary["base"]["games"].as_u64().unwrap() + summary["variant"]["games"].as_u64().unwrap(), 2);
    assert_eq!(sim.inner.played().len(), 2, "nothing else started");
    // Nothing playing: a cancel is final at once.
    let q = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    let c = cancel(&pool, "bryan", &q.item.id, &|e: &str| worker.playing(e)).await.unwrap();
    assert!(c.item.summary.unwrap().verdict.is_final);
}

#[tokio::test]
async fn a_cancel_between_picking_and_starting_games_starts_nothing() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let d = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    let jobs = worker.next_jobs(2).await.unwrap();
    assert_eq!(jobs.len(), 2);
    cancel(&pool, "bryan", &d.item.id, &idle).await.unwrap();
    // The write that starts games skips an experiment that is no longer queued or running.
    assert!(worker.mark_started(&jobs).await.unwrap().is_empty());
    let attempts: i64 = sqlx::query_scalar("SELECT SUM(attempts) FROM lab_experiment_games WHERE experiment_id = ?").bind(&d.item.id).fetch_one(&pool).await.unwrap();
    assert_eq!(attempts, 0);
    let status: String = sqlx::query_scalar("SELECT status FROM lab_experiments WHERE id = ?").bind(&d.item.id).fetch_one(&pool).await.unwrap();
    assert_eq!(status, "cancelled");
}

#[tokio::test]
async fn a_server_restart_settles_experiments_cancelled_with_games_in_flight() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let d = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    // Cancelled while a game was playing, then the server stopped before it was stored.
    cancel(&pool, "bryan", &d.item.id, &|_: &str| true).await.unwrap();
    assert_eq!(stored_summary(&pool, &d.item.id).await.1["verdict"]["final"], json!(false));
    let restarted = LabWorker::new(pool.clone(), 2, SimState::Starting);
    assert_eq!(restarted.settle_left_over().await.unwrap(), 1);
    assert_eq!(stored_summary(&pool, &d.item.id).await.1["verdict"]["final"], json!(true));
    assert_eq!(restarted.settle_left_over().await.unwrap(), 0, "only open ones");
}

/// cancel() and a game being stored at the same moment, on a file database with the server's pool
/// settings: the cancel's recount never overwrites the newer count (it did in about a third of the
/// rounds when cancel recounted outside a transaction).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_and_a_finishing_game_never_lose_a_result() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::connect(&format!("sqlite://{}", dir.path().join("t.db").display()), std::time::Duration::from_millis(crate::perf::SLOW_QUERY_MS)).await.unwrap();
    add_user(&pool, "bryan", false).await;
    let sim = FakeSim::new();
    for round in 0..30u64 {
        let id = format!("e{round}");
        sqlx::query(
            "INSERT INTO lab_experiments (id, owner_id, name, status, spec, games_total, games_done, engine, card_data, runner, difficulty, created_at, updated_at)
             VALUES (?, 'bryan', 'raw', 'running', '{}', 200, 0, 'e', 'c', 'r', 'Easy', 'now', 'now')",
        )
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
        let mut specs = Vec::new();
        for i in 0..200usize {
            let side = if i % 2 == 0 { BASE_ID } else { VARIANT_ID };
            let spec = GameSpec {
                game: format!("g{i}"),
                seed: i as u64,
                decks: vec![side.into(), "precons/a".into(), "precons/b".into(), "precons/c".into()],
                difficulty: "Easy".into(),
                max_turns: 120,
                max_actions: 200_000,
                max_seconds: 600,
                pilots: None,
            };
            let result = (i < 198).then(|| sim.play(&spec, &[], &LIMITS).to_line());
            sqlx::query("INSERT INTO lab_experiment_games (experiment_id, game, ord, spec, result, end_kind, attempts) VALUES (?,?,?,?,?,?,1)")
                .bind(&id)
                .bind(&spec.game)
                .bind(i as i64)
                .bind(serde_json::to_string(&spec).unwrap())
                .bind(&result)
                .bind(result.as_ref().map(|_| "win"))
                .execute(&pool)
                .await
                .unwrap();
            specs.push(spec);
        }
        let last = sim.play(&specs[198], &[], &LIMITS);
        let jitter = std::time::Duration::from_micros((round * 97) % 4000);
        let (p1, p2, id1, id2) = (pool.clone(), pool.clone(), id.clone(), id.clone());
        let cancelling = tokio::spawn(async move {
            // detail() can't read the raw '{}' spec afterwards; the cancel itself is what's tested.
            let _ = cancel(&p1, "bryan", &id1, &|_: &str| true).await;
        });
        let finishing = tokio::spawn(async move {
            tokio::time::sleep(jitter).await;
            assert!(store(&p2, &id2, "g198", &last).await.unwrap());
        });
        cancelling.await.unwrap();
        finishing.await.unwrap();
        let (done, summary) = stored_summary(&pool, &id).await;
        assert_eq!(done, 199, "round {round}");
        assert_eq!(summary["base"]["games"].as_u64().unwrap() + summary["variant"]["games"].as_u64().unwrap(), 199, "round {round}");
    }
}

#[tokio::test]
async fn a_pod_half_played_on_another_build_replays_on_this_one() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let d = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT game, spec FROM lab_experiment_games WHERE experiment_id = ? ORDER BY ord").bind(&d.item.id).fetch_all(&pool).await.unwrap();
    // An earlier server, on older card data, stored pod 0 and pod 1's base game. Pod 2 was split
    // across two other runners by a server without the check.
    let stamped = |i: usize, card_data: &str, runner: Option<&str>| {
        let mut r = sim.play(&serde_json::from_str(&rows[i].1).unwrap(), &[], &LIMITS);
        r.card_data = card_data.into();
        if let Some(runner) = runner {
            r.runner = runner.into();
        }
        r
    };
    for i in 0..3 {
        assert!(store(&pool, &d.item.id, &rows[i].0, &stamped(i, "olddata", None)).await.unwrap());
    }
    assert!(store(&pool, &d.item.id, &rows[4].0, &stamped(4, "fakecarddata0000", Some("older"))).await.unwrap());
    assert!(store(&pool, &d.item.id, &rows[5].0, &stamped(5, "fakecarddata0000", Some("newer"))).await.unwrap());
    // Pod 3's base game has a line that isn't JSON: it is never read as JSON, and stays.
    sqlx::query("UPDATE lab_experiment_games SET result = '{nope', end_kind = 'error' WHERE experiment_id = ? AND game = ?").bind(&d.item.id).bind(&rows[6].0).execute(&pool).await.unwrap();
    sqlx::query("UPDATE lab_experiments SET status = 'running' WHERE id = ?").bind(&d.item.id).execute(&pool).await.unwrap();

    let fresh = FakeSim::new();
    LabWorker::new(pool.clone(), 2, SimState::Ready(fresh.clone())).drain().await;
    let replayed: HashSet<String> = fresh.played().into_iter().map(|(s, _)| s.game).collect();
    assert!(!replayed.contains(&rows[0].0) && !replayed.contains(&rows[1].0), "a whole pod on one build is kept");
    for i in [2, 3, 4, 5, 7] {
        assert!(replayed.contains(&rows[i].0), "game {i} replayed on this build");
    }
    assert!(!replayed.contains(&rows[6].0));
    assert_eq!(replayed.len(), 97);
    let done = detail(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!(done.item.status, "done");
    let s = done.item.summary.as_ref().unwrap();
    assert_eq!((s.paired.pods, s.paired.split_builds, s.unscored.error), (49, 0, 1), "every scored pod on one build");
    let builds: Vec<(&str, &str, u32)> = s.builds.iter().map(|b| (b.build.card_data.as_str(), b.build.runner.as_str(), b.games)).collect();
    let runner = yama_play::lab::RUNNER;
    assert_eq!(builds, vec![("olddata", runner, 2), ("fakecarddata0000", runner, 97), ("unknown", "unknown", 1)]);
    // The label names every build the games ran on, not the one the experiment was created on.
    assert_eq!(done.item.label.card_data, "olddata, fakecarddata0000, unknown");
    assert_eq!(done.item.label.engine, format!("{ENGINE}, unknown"));
    assert_eq!(done.item.label.builds, s.builds);
}

#[tokio::test]
async fn the_label_follows_the_games_not_the_build_it_was_created_on() {
    let pool = fixture().await;
    let d = create(&pool, &user("bryan", false), swap_req(100), FakeSim::new().as_ref()).await.unwrap();
    assert_eq!((d.item.label.card_data.as_str(), d.item.label.builds.len()), ("fakecarddata0000", 0));
    // A card data refresh before it started: every game plays on the new data, and says so.
    struct Refreshed(Arc<FakeSim>);
    impl Simulator for Refreshed {
        fn card_data(&self) -> String {
            "newcarddata00000".into()
        }
        fn unknown(&self, cards: &[LabCard]) -> Vec<String> {
            self.0.unknown(cards)
        }
        fn play(&self, spec: &GameSpec, decks: &[Arc<LabList>], limits: &Limits) -> GameResult {
            let mut r = self.0.play(spec, decks, limits);
            r.card_data = self.card_data();
            r
        }
    }
    LabWorker::new(pool.clone(), 2, SimState::Ready(Arc::new(Refreshed(FakeSim::new())))).drain().await;
    let done = detail(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!(done.item.label.card_data, "newcarddata00000");
    assert_eq!(done.item.label.builds.iter().map(|b| b.games).collect::<Vec<_>>(), vec![100]);
}

/// Panics if the rules engine is ever asked about a list it would be expensive to look at.
struct Strict(Arc<FakeSim>);
impl Simulator for Strict {
    fn card_data(&self) -> String {
        self.0.card_data()
    }
    fn unknown(&self, cards: &[LabCard]) -> Vec<String> {
        let total: u64 = cards.iter().map(|c| u64::from(c.qty)).sum();
        assert!(cards.iter().all(|c| c.qty <= MAX_LINE_QTY) && total <= MAX_LIST_CARDS, "the engine was asked about an oversized list ({total} cards)");
        self.0.unknown(cards)
    }
    fn play(&self, spec: &GameSpec, decks: &[Arc<LabList>], limits: &Limits) -> GameResult {
        self.0.play(spec, decks, limits)
    }
}

#[tokio::test]
async fn oversized_lists_are_refused_before_any_engine_work() {
    let pool = fixture().await;
    let sim = Strict(FakeSim::new());
    let bryan = user("bryan", false);
    let top3 = json!({"kind": "precons_top", "n": 3});
    let pasted = |text: String| req(json!({"base": {"kind": "list", "text": text}, "variant": {"add": ["Sol Ring"]}, "field": top3, "games": 100}));
    for (text, says) in [
        ("Commander\n1 Ghave\nDeck\n4000000000 Forest".to_string(), "4000000000 copies of Forest"),
        // Past u32: not read as 100 (4294967396 mod 2^32).
        ("Commander\n1 Ghave\nDeck\n4294967396 Forest".to_string(), "4294967396 copies of Forest"),
        ("Commander\n1 Ghave\nDeck\n50000000 Forest".to_string(), "50000000 copies of Forest"),
        ("Commander\n1 Ghave\nDeck\n100 Forest\n100 Forest\n100 Forest".to_string(), "301 cards on 4 lines"),
        (format!("Commander\n1 Ghave\nDeck\n{}", (0..301).map(|i| format!("1 Card {i}\n")).collect::<String>()), "302 card lines"),
        (format!("1 Ghave\n{}", "1 Forest // padding to make the text long\n".repeat(2000)), "at most 64 KB"),
    ] {
        let (msg, details) = invalid(create(&pool, &bryan, pasted(text), &sim).await.unwrap_err());
        assert!(msg.starts_with("The base list: ") && msg.contains(says), "{msg}");
        assert_eq!(details["problems"]["variant"], json!([]));
    }
    // The changed list too, and too many cards to add and cut.
    let text_variant = req(json!({"base": {"kind": "precon", "id": "p1"}, "variant": {"text": "1 Ghave\n4000000000 Forest"}, "field": top3, "games": 100}));
    let (msg, details) = invalid(create(&pool, &bryan, text_variant, &sim).await.unwrap_err());
    assert!(msg.starts_with("The changed list: ") && msg.contains("4000000000 copies"), "{msg}");
    assert_eq!(details["problems"]["base"], json!([]));
    let many = req(json!({"base": {"kind": "precon", "id": "p1"}, "variant": {"add": vec!["Sol Ring"; 201]}, "field": top3, "games": 100}));
    assert!(invalid(create(&pool, &bryan, many, &sim).await.unwrap_err()).0.contains("201 cards to add and cut; at most 200"));
    let lots = req(json!({"base": {"kind": "precon", "id": "p1"}, "variant": {"add": vec!["Sol Ring"; 200]}, "field": top3, "games": 100}));
    // 200 more Sol Rings make one line of 201 copies.
    assert!(invalid(create(&pool, &bryan, lots, &sim).await.unwrap_err()).0.contains("The changed list: 201 copies of Sol Ring"));

    // A saved deck with a huge quantity: refused as a base, left out of a field of your decks.
    let mut huge = list_of("Atla", &[]);
    huge.last_mut().unwrap().1 = 50_000_000;
    let huge = deck(&pool, "bryan", "Huge", huge).await;
    let as_base = req(json!({"base": {"kind": "deck", "id": huge}, "variant": {"add": ["Sol Ring"]}, "field": top3, "games": 100}));
    assert!(invalid(create(&pool, &bryan, as_base, &sim).await.unwrap_err()).0.contains("50000000 copies of Forest"));
    for (name, c) in [("A", "Bruna"), ("B", "Cadric"), ("C", "Dina")] {
        deck(&pool, "bryan", name, list_of(c, &[])).await;
    }
    let mine = |field: Value| req(json!({"base": {"kind": "precon", "id": "p1"}, "variant": {"cut": ["Forest"], "add": ["Llanowar Elves"]}, "field": field, "games": 100}));
    let d = create(&pool, &bryan, mine(json!({"kind": "my_decks"})), &sim).await.unwrap();
    assert_eq!(d.item.field.as_ref().unwrap().decks, 3);
    assert!(d.warnings.iter().any(|w| w.contains("Huge")), "{:?}", d.warnings);
    delete(&pool, "bryan", &d.item.id).await.unwrap();
    let (_, details) = invalid(create(&pool, &bryan, mine(json!({"kind": "my_decks", "ids": [huge]})), &sim).await.unwrap_err());
    assert!(details["unplayable_decks"][&huge]["problems"][0].as_str().unwrap().contains("50000000 copies"), "{details}");
}

#[test]
fn merging_a_long_list_is_linear_and_keeps_the_first_line() {
    // 30,000 distinct lines took tens of seconds with the old pairwise merge.
    let lines: Vec<LabCard> = (0..30_000).rev().map(|i| LabCard { name: format!("Card {i:05}"), oracle_id: None, qty: 1, commander: false }).collect();
    let started = std::time::Instant::now();
    let out = normalize(lines);
    assert_eq!(out.len(), 30_000);
    assert_eq!(out[0].name, "Card 00000");
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
    // Repeats merge under the first line's name; commanders sort first.
    let out = normalize(vec![
        LabCard { name: "forest".into(), oracle_id: Some("f".into()), qty: 2, commander: false },
        LabCard { name: "Ghave".into(), oracle_id: Some("g".into()), qty: 1, commander: true },
        LabCard { name: "Forest".into(), oracle_id: Some("f".into()), qty: 3, commander: false },
        LabCard { name: "Sol Ring".into(), oracle_id: None, qty: 0, commander: false },
    ]);
    assert_eq!(out.iter().map(|c| (c.name.as_str(), c.qty)).collect::<Vec<_>>(), vec![("Ghave", 1), ("forest", 5)]);
}

#[tokio::test]
async fn a_user_at_the_limit_is_refused_before_anything_is_built() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let bryan = user("bryan", false);
    for _ in 0..3 {
        create(&pool, &bryan, swap_req(100), sim.as_ref()).await.unwrap();
    }
    let mut nope = swap_req(100);
    nope.base = Some(BaseChoice { kind: "precon".into(), id: Some("no-such-precon".into()), text: None, label: None });
    assert!(matches!(create(&pool, &bryan, nope, sim.as_ref()).await, Err(AppError::Conflict(_))));
}

#[tokio::test]
async fn the_queue_ahead_is_shown_to_admins_only() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    create(&pool, &user("other", false), swap_req(400), sim.as_ref()).await.unwrap();
    let mine = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    // Bryan doesn't learn how many games other people have queued.
    assert_eq!(mine.item.progress.games_ahead, None);
    assert_eq!(list(&pool, "bryan", &ListPage::default()).await.unwrap()[0].progress.games_ahead, None);
    let admins = create(&pool, &user("admin", true), swap_req(100), sim.as_ref()).await.unwrap();
    assert_eq!(admins.item.progress.games_ahead, Some(500));
}

#[tokio::test]
async fn pods_list_both_lists_games_side_by_side_for_the_owner_only() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let d = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    // Before any game: every pod, with its seats, and nothing played.
    let before = pods(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!(before.len(), 50);
    assert!(before.iter().all(|p| p.base.is_none() && p.variant.is_none()));
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    let after = pods(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!(after.iter().map(|p| p.pod).collect::<Vec<_>>(), (1..=50).collect::<Vec<_>>());
    for p in &after {
        // The open seat cycles, the other three seats name precons from the field.
        assert_eq!(usize::from(p.seat), (p.pod - 1) % 4);
        assert_eq!(p.seats.len(), 4);
        assert!(p.seats[usize::from(p.seat)].is_none());
        assert!(p.seats.iter().enumerate().all(|(i, s)| i == usize::from(p.seat) || s.as_deref().is_some_and(|l| l.starts_with("Precon p"))));
        let (b, v) = (p.base.as_ref().unwrap(), p.variant.as_ref().unwrap());
        assert!(b.game.ends_with("-base") && v.game.ends_with("-variant"));
        assert!(b.scored && b.end == "win" && b.turns == 9 && b.finished_at.is_some());
        assert_eq!(b.place == Some(1.0), b.won);
        // The fake simulator: whenever the base wins, so does the changed list.
        assert!(!b.won || v.won);
    }
    let s = detail(&pool, "bryan", &d.item.id).await.unwrap().item.summary.unwrap();
    assert_eq!(after.iter().filter(|p| p.base.as_ref().unwrap().won).count() as u32, s.base.wins);
    assert_eq!(after.iter().filter(|p| p.variant.as_ref().unwrap().won).count() as u32, s.variant.wins);
    // A loser shares the places below the winner.
    let lost = after.iter().find(|p| !p.base.as_ref().unwrap().won).unwrap();
    assert_eq!(lost.base.as_ref().unwrap().place, Some(3.0));
    assert!(matches!(pods(&pool, "other", &d.item.id).await, Err(AppError::NotFound(_))));
    assert!(matches!(pods(&pool, "bryan", "no-such-experiment").await, Err(AppError::NotFound(_))));

    // An unreadable result line shows as an unscored error, not a crash.
    sqlx::query("UPDATE lab_experiment_games SET result = 'not json' WHERE experiment_id = ? AND ord = 0").bind(&d.item.id).execute(&pool).await.unwrap();
    let first = pods(&pool, "bryan", &d.item.id).await.unwrap().remove(0);
    let b = first.base.unwrap();
    assert_eq!((b.end.as_str(), b.scored, b.won), ("error", false, false));
    assert!(b.error.unwrap().starts_with("unreadable result line"));
}

#[tokio::test]
async fn the_pace_comes_from_recent_games_then_from_game_lengths() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let ok = || Ok(());
    let (bryan, admin) = (user("bryan", false), user("admin", true));
    let secs = |p: &Pace| p.estimates.iter().map(|e| (e.games, e.seconds)).collect::<Vec<_>>();
    // Nothing played yet: nothing to go on.
    let p = pace(&pool, &admin, 2, ok()).await.unwrap();
    assert_eq!((p.available, p.seconds_per_game, p.basis.as_deref(), p.your_pending), (true, None, None, 0));
    assert!(p.estimates.is_empty());
    let d = create(&pool, &bryan, swap_req(100), sim.as_ref()).await.unwrap();
    assert_eq!(pace(&pool, &bryan, 2, ok()).await.unwrap().your_pending, 100);
    assert_eq!(pace(&pool, &user("other", false), 2, ok()).await.unwrap().your_pending, 0);
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;

    // Games from long ago: the mean game length (30 s) over two threads.
    sqlx::query("UPDATE lab_experiment_games SET result = json_set(result, '$.ms', 30000), finished_at = '2026-01-01T00:00:00Z'").execute(&pool).await.unwrap();
    sqlx::query("UPDATE lab_experiments SET updated_at = '2026-01-01T00:00:00Z'").execute(&pool).await.unwrap();
    let p = pace(&pool, &admin, 2, ok()).await.unwrap();
    assert_eq!((p.seconds_per_game, p.basis.as_deref(), p.sample, p.your_pending), (Some(15.0), Some("average"), Some(100), 0));
    assert_eq!(secs(&p), vec![(100, 1500), (200, 3000), (400, 6000)]);
    // Anyone else gets the expected times only, rounded up to 5 minutes.
    let p = pace(&pool, &bryan, 2, ok()).await.unwrap();
    assert_eq!((p.seconds_per_game, p.basis.as_deref(), p.sample), (None, None, None));
    assert_eq!(secs(&p), vec![(100, 1500), (200, 3000), (400, 6000)]);
    // An unreadable result line is skipped, not an error.
    sqlx::query("UPDATE lab_experiment_games SET result = 'not json' WHERE experiment_id = ? AND ord = 99").bind(&d.item.id).execute(&pool).await.unwrap();
    let p = pace(&pool, &admin, 2, ok()).await.unwrap();
    assert_eq!((p.seconds_per_game, p.sample), (Some(15.0), Some(99)));
    let none = pace(&pool, &admin, 0, ok()).await.unwrap();
    assert_eq!(none.seconds_per_game, None);
    assert!(none.estimates.is_empty());

    // Five games finished over the last 40 seconds: one every 10 seconds.
    let now = chrono::Utc::now();
    let at = |s: i64| (now - chrono::Duration::seconds(s)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    for (i, s) in [40, 30, 20, 10, 0].into_iter().enumerate() {
        sqlx::query("UPDATE lab_experiment_games SET finished_at = ? WHERE experiment_id = ? AND ord = ?").bind(at(s)).bind(&d.item.id).bind(i as i64).execute(&pool).await.unwrap();
    }
    sqlx::query("UPDATE lab_experiments SET updated_at = ?").bind(at(0)).execute(&pool).await.unwrap();
    let p = pace(&pool, &admin, 2, ok()).await.unwrap();
    assert_eq!((p.basis.as_deref(), p.sample), (Some("recent"), Some(5)));
    assert!((p.seconds_per_game.unwrap() - 10.0).abs() < 1e-9);
    assert_eq!(secs(&p), vec![(100, 1020), (200, 2040), (400, 4020)]);
    let p = pace(&pool, &bryan, 2, ok()).await.unwrap();
    assert_eq!((p.seconds_per_game, p.basis.as_deref(), p.sample), (None, None, None));
    assert_eq!(secs(&p), vec![(100, 1200), (200, 2100), (400, 4200)]);

    // Why a new experiment can't start, when it can't.
    let off = pace(&pool, &bryan, 0, Err("Simulations are turned off".into())).await.unwrap();
    assert_eq!((off.available, off.message.as_deref(), off.threads), (false, Some("Simulations are turned off"), 0));
}

#[tokio::test]
async fn another_users_queue_cant_be_worked_out_from_the_pace_and_eta() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let ok = || Ok(());
    let (bryan, other, admin) = (user("bryan", false), user("other", false), user("admin", true));
    // A recent pace: an earlier experiment finished five games over the last 40 seconds.
    let first = create(&pool, &admin, swap_req(100), sim.as_ref()).await.unwrap();
    LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone())).drain().await;
    sqlx::query("UPDATE lab_experiment_games SET finished_at = '2026-01-01T00:00:00Z'").execute(&pool).await.unwrap();
    let now = chrono::Utc::now();
    let at = |s: i64| (now - chrono::Duration::seconds(s)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    for (i, s) in [40, 30, 20, 10, 0].into_iter().enumerate() {
        sqlx::query("UPDATE lab_experiment_games SET finished_at = ? WHERE experiment_id = ? AND ord = ?").bind(at(s)).bind(&first.item.id).bind(i as i64).execute(&pool).await.unwrap();
    }
    sqlx::query("UPDATE lab_experiments SET updated_at = ?").bind(at(0)).execute(&pool).await.unwrap();

    // Someone else's experiment is queued ahead of Bryan's.
    let theirs = create(&pool, &other, swap_req(100), sim.as_ref()).await.unwrap();
    let mine = create(&pool, &bryan, swap_req(100), sim.as_ref()).await.unwrap();
    async fn seen(pool: &SqlitePool, viewer: &User, id: &str) -> (Pace, Progress) {
        let p = pace(pool, viewer, 2, Ok(())).await.unwrap();
        (p, detail(pool, &viewer.id, id).await.unwrap().item.progress)
    }
    let (p, before) = seen(&pool, &bryan, &mine.item.id).await;
    // No exact pace or sample of anyone's games, and a rough ETA.
    assert_eq!((p.seconds_per_game, p.basis.as_deref(), p.sample, before.games_ahead), (None, None, None, None));
    let eta = before.eta_seconds.expect("an ETA from the recent pace");
    assert_eq!(eta % ROUGH_SECONDS, 0);

    // Ten fewer games queued by the other user change nothing Bryan sees.
    sqlx::query("UPDATE lab_experiment_games SET result = 'x' WHERE experiment_id = ? AND ord < 10").bind(&theirs.item.id).execute(&pool).await.unwrap();
    let (p2, after) = seen(&pool, &bryan, &mine.item.id).await;
    assert_eq!((p2, after.eta_seconds), (p, Some(eta)));
    // Admins still get the exact pace.
    let admins = pace(&pool, &admin, 2, ok()).await.unwrap();
    assert!((admins.seconds_per_game.unwrap() - 10.0).abs() < 1e-9);
}

/// A power user who signed up with Google and has no invite (`User::limited`): the standard
/// allowance.
async fn add_open_user(pool: &SqlitePool, id: &str) -> User {
    sqlx::query("INSERT INTO users (id, google_sub, email, display_name, created_at) VALUES (?,?,?,?, 'now')")
        .bind(id)
        .bind(format!("g-{id}"))
        .bind(format!("{id}@gmail.com"))
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    User { limited: true, ..user(id, false) }
}

#[tokio::test]
async fn power_users_who_signed_up_with_google_get_the_standard_allowance() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let newbie = add_open_user(&pool, "newbie").await;
    let quota = crate::config::LabQuota { queue_games: 2_000, open_queue_games: 400, open_daily_games: 200, ..Default::default() };
    for g in [200, 400] {
        assert!(bad(create_with(&pool, &newbie, swap_req(g), sim.as_ref(), &quota, &ForgeAccess::default()).await.unwrap_err()).contains("must be 100"));
    }
    let first = create_with(&pool, &newbie, swap_req(100), sim.as_ref(), &quota, &ForgeAccess::default()).await.unwrap();
    // One at a time: nothing waits behind it.
    let e = create_with(&pool, &newbie, swap_req(100), sim.as_ref(), &quota, &ForgeAccess::default()).await.unwrap_err();
    assert!(matches!(&e, AppError::Conflict(m) if m.contains("one experiment at a time") && m.contains("About page") && !m.contains("invite")), "{e:?}");
    // Deleting a run doesn't hand back the day's games.
    delete(&pool, "newbie", &first.item.id).await.unwrap();
    let second = create_with(&pool, &newbie, swap_req(100), sim.as_ref(), &quota, &ForgeAccess::default()).await.unwrap();
    cancel(&pool, "newbie", &second.item.id, &idle).await.unwrap();
    let e = create_with(&pool, &newbie, swap_req(100), sim.as_ref(), &quota, &ForgeAccess::default()).await.unwrap_err();
    assert!(matches!(&e, AppError::Conflict(m) if m.contains("200 games a day") && m.contains("asked for 200") && !m.contains("invite")), "{e:?}");
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_experiments WHERE owner_id = 'newbie'").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 1, "refused runs leave nothing behind");
    // The day's count moves on.
    sqlx::query("UPDATE lab_usage SET created_at = '2026-01-01T00:00:00Z'").execute(&pool).await.unwrap();
    create_with(&pool, &newbie, swap_req(100), sim.as_ref(), &quota, &ForgeAccess::default()).await.unwrap();

    // The Try page hears what it may offer.
    let p = pace(&pool, &newbie, 2, Ok(())).await.unwrap();
    assert_eq!(p.game_choices, vec![100]);
    let a = allowance(&pool, &newbie, &quota).await.unwrap().unwrap();
    assert_eq!((a.games, a.at_a_time, a.games_per_day, a.used_today), (100, 1, 200, 100));
    assert_eq!(pace(&pool, &user("bryan", false), 2, Ok(())).await.unwrap().game_choices, vec![100, 200, 400]);
    assert!(allowance(&pool, &user("bryan", false), &quota).await.unwrap().is_none());
}

#[tokio::test]
async fn the_queue_is_capped_for_everyone_but_admins_with_a_smaller_share_for_the_smaller_allowances() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let quota = crate::config::LabQuota { queue_games: 300, open_queue_games: 100, open_daily_games: 1_000, ..Default::default() };
    let (a, b) = (add_open_user(&pool, "new-a").await, add_open_user(&pool, "new-b").await);
    let first = create_with(&pool, &a, swap_req(100), sim.as_ref(), &quota, &ForgeAccess::default()).await.unwrap();
    let busy = |r: Result<ExperimentDetail, AppError>| matches!(r, Err(AppError::Conflict(m)) if m.contains("too many games waiting"));
    // New accounts' share is full; members still have room.
    assert!(busy(create_with(&pool, &b, swap_req(100), sim.as_ref(), &quota, &ForgeAccess::default()).await));
    create_with(&pool, &user("bryan", false), swap_req(200), sim.as_ref(), &quota, &ForgeAccess::default()).await.unwrap();
    // Now everyone's is full, but not for an admin.
    assert!(busy(create_with(&pool, &user("other", false), swap_req(100), sim.as_ref(), &quota, &ForgeAccess::default()).await));
    create_with(&pool, &user("admin", true), swap_req(400), sim.as_ref(), &quota, &ForgeAccess::default()).await.unwrap();
    // Played games stop counting.
    sqlx::query("UPDATE lab_experiment_games SET result = '{}' WHERE experiment_id = ?").bind(&first.item.id).execute(&pool).await.unwrap();
    create_with(&pool, &user("other", false), swap_req(100), sim.as_ref(), &quota, &ForgeAccess::default()).await.unwrap();
}

/// Short runs keep to half of the smaller queue share, so a crowd of new accounts can't shut the
/// power users on the standard allowance out of it; and a disabled account's waiting games, which
/// the worker doesn't play, don't hold places.
#[tokio::test]
async fn short_runs_keep_to_their_part_of_the_queue() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let fa = ForgeAccess::default();
    // 200 games may wait from the smaller allowances, 100 of them from short accounts: five runs.
    let quota = crate::config::LabQuota { queue_games: 2_000, open_queue_games: 200, ..Default::default() };
    let busy = |r: Result<ExperimentDetail, AppError>| matches!(r, Err(AppError::Conflict(m)) if m.contains("too many games waiting"));
    let mut shorts = vec![];
    for i in 0..6 {
        let id = format!("short-{i}");
        add_user(&pool, &id, false).await;
        shorts.push(User { power: false, ..user(&id, false) });
    }
    for u in &shorts[..5] {
        create_with(&pool, u, swap_req(20), sim.as_ref(), &quota, &fa).await.unwrap();
    }
    assert!(busy(create_with(&pool, &shorts[5], swap_req(20), sim.as_ref(), &quota, &fa).await), "the short accounts' part is full");
    // A power user on the standard allowance still has the rest of the share, and then it is full.
    let standard = add_open_user(&pool, "standard").await;
    sqlx::query("UPDATE users SET power_user = 1 WHERE id = 'standard'").execute(&pool).await.unwrap();
    create_with(&pool, &standard, swap_req(100), sim.as_ref(), &quota, &fa).await.unwrap();
    let other = add_open_user(&pool, "standard-2").await;
    sqlx::query("UPDATE users SET power_user = 1 WHERE id = 'standard-2'").execute(&pool).await.unwrap();
    assert!(busy(create_with(&pool, &other, swap_req(100), sim.as_ref(), &quota, &fa).await));
    // An account an admin turned off: its games wait unplayed, and no longer hold a place.
    sqlx::query("UPDATE users SET disabled_at = 'now' WHERE id = 'short-0'").execute(&pool).await.unwrap();
    create_with(&pool, &shorts[5], swap_req(20), sim.as_ref(), &quota, &fa).await.unwrap();
    assert!(busy(create_with(&pool, &other, swap_req(100), sim.as_ref(), &quota, &fa).await), "the share is still full for the standard allowance");
}

#[tokio::test]
async fn a_disabled_accounts_experiments_wait() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    create(&pool, &user("other", false), swap_req(100), sim.as_ref()).await.unwrap();
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    sqlx::query("UPDATE users SET disabled_at = 'now' WHERE id = 'other'").execute(&pool).await.unwrap();
    assert!(worker.next_jobs(2).await.unwrap().is_empty());
    sqlx::query("UPDATE users SET disabled_at = NULL WHERE id = 'other'").execute(&pool).await.unwrap();
    assert_eq!(worker.next_jobs(2).await.unwrap().len(), 2);
}

// ── modes: one deck as it is, two decks against the same field, decks head to head ──

#[tokio::test]
async fn a_deck_as_it_is_plays_every_pod_once_against_the_field() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let bryan = user("bryan", false);
    let d = create(&pool, &bryan, req(json!({"mode": "solo", "base": {"kind": "precon", "id": "p1"}, "field": {"kind": "precons_top", "n": 3}, "games": 100})), sim.as_ref()).await.unwrap();
    assert_eq!(d.item.mode, Mode::Solo);
    assert_eq!(d.item.name, "Precon p1 as it is");
    assert!(d.lists.variant.is_none() && d.item.variant.is_none());
    assert_eq!(d.item.progress.total, 100);
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    let played = sim.played();
    assert_eq!(played.len(), 100, "each pod once");
    assert!(played.iter().all(|(g, _)| g.decks.iter().filter(|x| *x == BASE_ID).count() == 1 && !g.decks.iter().any(|x| x == VARIANT_ID)));
    let done = detail(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!(done.item.status, "done");
    let s = done.item.summary.unwrap();
    assert_eq!(s.base.games, 100);
    assert_eq!(s.variant.games, 0);
    // The fake wins 2 in 10: below a quarter.
    assert!(s.verdict.text.contains("no edge would be 25%"), "{}", s.verdict.text);
    assert!(s.method.contains("no changed copy"));
    // Its rows list one game per pod.
    let pods = pods(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!(pods.len(), 100);
    assert!(pods.iter().all(|p| p.base.is_some() && p.variant.is_none() && p.game.is_none()));
    // Run again with more games: the same list and opponents, a new seed.
    let again = again(&pool, &bryan, &d.item.id, 200, None, sim.as_ref()).await.unwrap();
    assert_eq!((again.item.mode, again.item.progress.total), (Mode::Solo, 200));
    assert_eq!(again.item.name, "Precon p1 as it is (200 games)");
    assert_ne!(again.seed, done.seed);
    assert_eq!(again.lists.base.sha256, done.lists.base.sha256);
    let again2 = again_with_name(&pool, &bryan, &again.item.id).await;
    assert_eq!(again2, "Precon p1 as it is (100 games)", "the games ending is replaced, not stacked");
}

async fn again_with_name(pool: &SqlitePool, user: &User, id: &str) -> String {
    let sim = FakeSim::new();
    again(pool, user, id, 100, None, sim.as_ref()).await.unwrap().item.name
}

#[tokio::test]
async fn two_decks_play_the_same_pods_and_neither_is_in_the_field() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let bryan = user("bryan", false);
    let mine = deck(&pool, "bryan", "Elf ball", list_of("Ghave", &["Llanowar Elves"])).await;
    let r = req(json!({
        "mode": "compare",
        "base": {"kind": "deck", "id": mine},
        "other": {"kind": "precon", "id": "p2"},
        "field": {"kind": "precons_all"},
        "games": 100
    }));
    let d = create(&pool, &bryan, r, sim.as_ref()).await.unwrap();
    assert_eq!(d.item.mode, Mode::Compare);
    assert_eq!(d.item.name, "Elf ball vs Precon p2");
    assert_eq!(d.item.entrants.iter().map(|e| e.label.as_str()).collect::<Vec<_>>(), ["Elf ball", "Precon p2"]);
    let v = d.item.variant.as_ref().unwrap();
    assert_eq!(v.label, "Precon p2");
    assert!(v.added.is_empty() && v.cut.is_empty(), "whole decks, not a change");
    assert!(d.opponents.iter().all(|o| o.id != "precons/p2" && o.id != "precons/p6"), "deck B and unplayable precons stay out of the field");
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    let played = sim.played();
    assert_eq!(played.len(), 100);
    let mut by_seed: HashMap<u64, Vec<&GameSpec>> = HashMap::new();
    for (g, _) in &played {
        by_seed.entry(g.seed).or_default().push(g);
    }
    for games in by_seed.values() {
        assert_eq!(games.len(), 2, "each pod twice, once per deck");
        let open = |g: &GameSpec| g.decks.iter().position(|x| x == BASE_ID || x == VARIANT_ID).unwrap();
        assert_eq!(open(games[0]), open(games[1]), "same seat");
        let rest = |g: &GameSpec| g.decks.iter().filter(|x| *x != BASE_ID && *x != VARIANT_ID).cloned().collect::<Vec<_>>();
        assert_eq!(rest(games[0]), rest(games[1]), "same opponents in the same seats");
    }
    let s = detail(&pool, "bryan", &d.item.id).await.unwrap().item.summary.unwrap();
    assert_eq!(s.paired.pods, 50);
    // The same list twice is refused.
    let same = req(json!({"mode": "compare", "base": {"kind": "precon", "id": "p2"}, "other": {"kind": "precon", "id": "p2"}, "field": {"kind": "precons_all"}, "games": 100}));
    assert!(bad(create(&pool, &bryan, same, sim.as_ref()).await.unwrap_err()).contains("same list"));
    let missing = req(json!({"mode": "compare", "base": {"kind": "precon", "id": "p2"}, "field": {"kind": "precons_all"}, "games": 100}));
    assert!(bad(create(&pool, &bryan, missing, sim.as_ref()).await.unwrap_err()).contains("other is required"));
}

#[tokio::test]
async fn decks_head_to_head_rotate_seats_and_count_who_finished_ahead() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let bryan = user("bryan", false);
    let a = deck(&pool, "bryan", "Elf ball", list_of("Ghave", &["Llanowar Elves"])).await;
    let b = deck(&pool, "bryan", "Bears", list_of("Atla", &["Grizzly Bears"])).await;
    let r = req(json!({
        "mode": "versus",
        "entrants": [{"kind": "deck", "id": a}, {"kind": "deck", "id": b}, {"kind": "precon", "id": "p3"}],
        "field": {"kind": "precons_top", "n": 3},
        "games": 100
    }));
    let d = create(&pool, &bryan, r, sim.as_ref()).await.unwrap();
    assert_eq!(d.item.mode, Mode::Versus);
    assert_eq!(d.item.name, "Elf ball vs Bears vs Precon p3");
    assert_eq!(d.lists.entrants.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), ["e0", "e1", "e2"]);
    assert!(d.opponents.iter().all(|o| o.id != "precons/p3"), "an entrant isn't a filler too");
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    let played = sim.played();
    assert_eq!(played.len(), 100);
    let mut seats: HashMap<(String, usize), usize> = HashMap::new();
    for (g, _) in &played {
        for e in ["e0", "e1", "e2"] {
            assert_eq!(g.decks.iter().filter(|x| *x == e).count(), 1, "{e} in every game");
        }
        for (i, x) in g.decks.iter().enumerate() {
            *seats.entry((x.clone(), i)).or_default() += 1;
        }
    }
    for e in ["e0", "e1", "e2"] {
        assert_eq!(seats[&(e.to_string(), 0)], 25, "{e} goes first a quarter of the time");
    }
    let s = detail(&pool, "bryan", &d.item.id).await.unwrap().item.summary.unwrap();
    let v = s.versus.as_ref().unwrap();
    assert_eq!(v.games, 100);
    let wins: Vec<u32> = v.entrants.iter().map(|e| e.wins).collect();
    assert_eq!(wins.iter().sum::<u32>(), 100);
    assert!(wins[0] > 60 && wins[1] > 0 && wins[2] == 0, "{wins:?}");
    let ab = v.meetings.iter().find(|m| (m.a, m.b) == (0, 1)).unwrap();
    assert_eq!((ab.a_ahead, ab.b_ahead, ab.ties), (wins[0], wins[1], 0));
    // The list leaves the meetings out: by far the biggest part of a big run's summary, shown on
    // the run's own page only.
    let listed = list(&pool, "bryan", &ListPage::default()).await.unwrap();
    let lv = listed.iter().find(|e| e.id == d.item.id).unwrap().summary.as_ref().unwrap().versus.as_ref().unwrap();
    assert!(lv.meetings.is_empty() && lv.games == 100 && lv.entrants.len() == 3);
    assert_eq!(v.entrants.iter().map(|e| e.games).collect::<Vec<_>>(), [100, 100, 100]);
    assert_eq!(v.avg_turns, Some(9.0));
    assert!(s.verdict.text.contains("Elf ball wins most often"), "{}", s.verdict.text);
    // Rows name every seat and the winner.
    let rows = pods(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!(rows.len(), 100);
    assert!(rows.iter().all(|p| p.game.as_ref().is_some_and(|g| g.winner.is_some()) && p.seats.iter().all(|x| x.is_some())));
    // Someone else can't see or rerun it.
    assert!(matches!(pods(&pool, "other", &d.item.id).await, Err(AppError::NotFound(_))));
    assert!(matches!(again(&pool, &user("other", false), &d.item.id, 100, None, sim.as_ref()).await, Err(AppError::NotFound(_))));
    // Run again keeps the entrants and the fillers.
    let more = again(&pool, &bryan, &d.item.id, 200, None, sim.as_ref()).await.unwrap();
    assert_eq!((more.item.mode, more.item.progress.total, more.lists.entrants.len()), (Mode::Versus, 200, 3));
}

#[tokio::test]
async fn two_decks_one_on_one_and_bad_head_to_head_requests() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let bryan = user("bryan", false);
    let two = json!([{"kind": "precon", "id": "p1"}, {"kind": "precon", "id": "p2"}]);
    let d = create(&pool, &bryan, req(json!({"mode": "versus", "entrants": two, "pod": 2, "games": 100})), sim.as_ref()).await.unwrap();
    assert_eq!(d.item.field.as_ref().unwrap().kind, "none");
    assert_eq!(d.item.label.pod, 2, "the label says 1v1");
    assert!(d.opponents.is_empty());
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    let played = sim.played();
    assert!(played.iter().all(|(g, _)| g.decks.len() == 2));
    assert_eq!(played.iter().filter(|(g, _)| g.decks[0] == "e0").count(), 50, "each goes first half the time");
    let s = detail(&pool, "bryan", &d.item.id).await.unwrap().item.summary.unwrap();
    assert!(s.verdict.text.starts_with("Precon p1 probably finishes ahead of Precon p2"), "{}", s.verdict.text);
    // Two decks in pods of four need a field for the empty seats; with one it plays.
    assert!(bad(create(&pool, &bryan, req(json!({"mode": "versus", "entrants": two, "games": 100})), sim.as_ref()).await.unwrap_err()).contains("field is required"));
    let four = create(&pool, &bryan, req(json!({"mode": "versus", "entrants": two, "field": {"kind": "precons_all"}, "games": 100})), sim.as_ref()).await.unwrap();
    assert_eq!(four.item.label.pod, 4);
    // Bad requests.
    let one = json!([{"kind": "precon", "id": "p1"}]);
    assert!(bad(create(&pool, &bryan, req(json!({"mode": "versus", "entrants": one, "games": 100})), sim.as_ref()).await.unwrap_err()).contains("2 to 4"));
    let dup = json!([{"kind": "precon", "id": "p1"}, {"kind": "precon", "id": "p1"}]);
    assert!(bad(create(&pool, &bryan, req(json!({"mode": "versus", "entrants": dup, "pod": 2, "games": 100})), sim.as_ref()).await.unwrap_err()).contains("same list"));
    let three = json!([{"kind": "precon", "id": "p1"}, {"kind": "precon", "id": "p2"}, {"kind": "precon", "id": "p3"}]);
    assert!(bad(create(&pool, &bryan, req(json!({"mode": "versus", "entrants": three, "pod": 2, "games": 100})), sim.as_ref()).await.unwrap_err()).contains("exactly two"));
    let unplayable = json!([{"kind": "precon", "id": "p1"}, {"kind": "precon", "id": "p6"}]);
    let (_, details) = invalid(create(&pool, &bryan, req(json!({"mode": "versus", "entrants": unplayable, "pod": 2, "games": 100})), sim.as_ref()).await.unwrap_err());
    assert_eq!(details["unknown"]["entrants"]["1"], json!(["Mystery Card"]));
    assert!(bad(create(&pool, &bryan, req(json!({"mode": "duel", "entrants": two, "pod": 2, "games": 100})), sim.as_ref()).await.unwrap_err()).contains("mode"));
    // Someone else's deck is "not found".
    let theirs = deck(&pool, "other", "Theirs", list_of("Bruna", &[])).await;
    let r = req(json!({"mode": "versus", "entrants": [{"kind": "precon", "id": "p1"}, {"kind": "deck", "id": theirs}], "pod": 2, "games": 100}));
    assert!(matches!(create(&pool, &bryan, r, sim.as_ref()).await, Err(AppError::NotFound(_))));
}

#[tokio::test]
async fn the_new_modes_share_the_allowance_and_the_daily_cap() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let newcomer = add_open_user(&pool, "newbie").await;
    // 100 games, one at a time, for any mode.
    let two = json!([{"kind": "precon", "id": "p1"}, {"kind": "precon", "id": "p2"}]);
    assert!(bad(create(&pool, &newcomer, req(json!({"mode": "versus", "entrants": two, "pod": 2, "games": 200})), sim.as_ref()).await.unwrap_err()).contains("100"));
    let first = create(&pool, &newcomer, req(json!({"mode": "solo", "base": {"kind": "precon", "id": "p1"}, "field": {"kind": "precons_top", "n": 3}, "games": 100})), sim.as_ref()).await.unwrap();
    assert!(matches!(create(&pool, &newcomer, req(json!({"mode": "versus", "entrants": two, "pod": 2, "games": 100})), sim.as_ref()).await, Err(AppError::Conflict(_))));
    assert!(matches!(again(&pool, &newcomer, &first.item.id, 100, None, sim.as_ref()).await, Err(AppError::Conflict(_))));
    // A retried "again" with the same op id returns the first one.
    let bryan = user("bryan", false);
    let base = create(&pool, &bryan, swap_req(100), sim.as_ref()).await.unwrap();
    let x = again(&pool, &bryan, &base.item.id, 200, Some("again-1"), sim.as_ref()).await.unwrap();
    let y = again(&pool, &bryan, &base.item.id, 200, Some("again-1"), sim.as_ref()).await.unwrap();
    assert_eq!(x.item.id, y.item.id);
    assert_eq!(x.item.variant, base.item.variant, "the same change");
}

#[tokio::test]
async fn a_short_pick_of_your_decks_sits_in_every_pod_with_precons_filling_the_rest() {
    // Bryan's setup (22 Oct 2026): his deck with a change, against one of his other decks.
    let pool = fixture().await;
    let sim = FakeSim::new();
    let bryan = user("bryan", false);
    let riders = deck(&pool, "bryan", "Riders of Rohan Upgraded 100", list_of("Ghave", &["Llanowar Elves"])).await;
    let lorehold = deck(&pool, "bryan", "Lorehold", list_of("Atla", &["Grizzly Bears"])).await;
    let r = req(json!({
        "base": {"kind": "deck", "id": riders},
        "variant": {"cut": ["Llanowar Elves"], "add": ["Elvish Mystic"]},
        "field": {"kind": "my_decks", "ids": [lorehold]},
        "games": 100,
        "difficulty": "Medium",
        "name": "Test terrain"
    }));
    let d = create(&pool, &bryan, r, sim.as_ref()).await.unwrap();
    let f = d.item.field.clone().unwrap();
    assert_eq!(f.every_pod, 1);
    assert!(f.label.starts_with("Lorehold in every pod, with "), "{}", f.label);
    assert_eq!(d.item.name, "Test terrain");
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    let played = sim.played();
    assert_eq!(played.len(), 100);
    let lore = format!("deck/{lorehold}");
    assert!(played.iter().all(|(g, _)| g.decks.contains(&lore) && g.difficulty == "Medium"), "Lorehold sits in every game");
    let done = detail(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!(done.item.status, "done");
    // As it is, against the same pick.
    let solo = req(json!({"mode": "solo", "base": {"kind": "deck", "id": riders}, "field": {"kind": "my_decks", "ids": [lorehold]}, "games": 100, "difficulty": "Medium"}));
    let s = create(&pool, &bryan, solo, sim.as_ref()).await.unwrap();
    assert_eq!(s.item.field.unwrap().every_pod, 1);
}

// ── Forge as a second engine ────────────────────────────────────────────────

use super::forge::{ForgeCards, ForgeClient, ForgePlay, ForgeStatus};
use futures_util::future::BoxFuture;
use std::sync::atomic::AtomicBool;

/// A Forge worker in memory: the tested seat wins when seed % 10 < 5 (the changed list never
/// does better), names in `unknown` are cards Forge doesn't know, and it can be offline or lose
/// every game it's handed.
#[derive(Default)]
struct FakeForge {
    unknown: HashSet<String>,
    offline: AtomicBool,
    lose_games: AtomicBool,
    played: Mutex<Vec<ForgePlay>>,
    checked: AtomicUsize,
}

impl FakeForge {
    fn new(unknown: &[&str]) -> Arc<Self> {
        Arc::new(FakeForge { unknown: unknown.iter().map(|s| s.to_string()).collect(), ..Default::default() })
    }
    fn status_now(&self) -> ForgeStatus {
        ForgeStatus { engine: "forge 9.9".into(), card_data: "forge res 9.9".into(), runner: "fake worker".into(), slots: 3, running: 0, profiles: vec!["Default".into()] }
    }
}

impl ForgeClient for FakeForge {
    fn status(&self) -> BoxFuture<'static, Result<ForgeStatus, String>> {
        let r = if self.offline.load(Ordering::SeqCst) { Err("connection refused".to_string()) } else { Ok(self.status_now()) };
        Box::pin(async move { r })
    }
    fn check(&self, names: Vec<String>) -> BoxFuture<'static, Result<Vec<String>, String>> {
        self.checked.fetch_add(names.len(), Ordering::SeqCst);
        let u: Vec<String> = names.into_iter().filter(|n| self.unknown.contains(n)).collect();
        Box::pin(async move { Ok(u) })
    }
    fn play(&self, req: ForgePlay) -> BoxFuture<'static, Result<GameResult, String>> {
        self.played.lock().unwrap().push(req.clone());
        if self.lose_games.load(Ordering::SeqCst) {
            return Box::pin(async move { Err("the Forge worker restarted".to_string()) });
        }
        let spec = req.spec;
        let mut r = GameResult::new(&spec, "forge res 9.9");
        r.engine = "forge 9.9".into();
        r.runner = "fake worker".into();
        r.difficulty = req.profile;
        let n = spec.decks.len() as u8;
        let seat = spec.decks.iter().position(|d| d == BASE_ID || d == VARIANT_ID || d == "e0").unwrap_or(0) as u8;
        let winner = if spec.seed % 10 < 5 { seat } else { (seat + 1) % n };
        r.end = End::Win;
        r.winner = Some(winner);
        r.first_seat = Some(0);
        r.placements = vec![vec![winner], (0..n).filter(|s| *s != winner).collect()];
        r.turns = 40;
        r.ms = 200_000;
        Box::pin(async move { Ok(r) })
    }
}

fn forge_access(f: &Arc<FakeForge>) -> ForgeAccess {
    ForgeAccess { client: Some(f.clone() as Arc<dyn ForgeClient>), cards: Some(Arc::new(ForgeCards::new("forge 9.9"))), engine: Some("forge 9.9".into()) }
}

fn with_engine(mut r: NewExperiment, engine: &str) -> NewExperiment {
    r.engine = Some(engine.into());
    r
}

#[tokio::test]
async fn forge_runs_need_a_forge_worker_and_a_known_profile() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let quota = crate::config::LabQuota::default();
    let bryan = user("bryan", false);
    let e = create_with(&pool, &bryan, with_engine(swap_req(100), "forge"), sim.as_ref(), &quota, &ForgeAccess::default()).await.unwrap_err();
    assert!(matches!(&e, AppError::Unavailable(m) if m.contains("Forge isn't set up")), "{e:?}");
    let f = FakeForge::new(&[]);
    let mut r = with_engine(swap_req(100), "forge");
    r.forge_ai = Some("Random".into());
    assert!(bad(create_with(&pool, &bryan, r, sim.as_ref(), &quota, &forge_access(&f)).await.unwrap_err()).contains("forge_ai"));
    assert!(bad(create_with(&pool, &bryan, with_engine(swap_req(100), "xmage"), sim.as_ref(), &quota, &forge_access(&f)).await.unwrap_err()).contains("phase, forge or both"));
    let mut r = with_engine(swap_req(100), "forge");
    r.forge_ai = Some("reckless".into());
    let d = create_with(&pool, &bryan, r, sim.as_ref(), &quota, &forge_access(&f)).await.unwrap();
    assert_eq!(d.item.engines.forge_ai.as_deref(), Some("Reckless"));
    assert_eq!((d.item.label.engine.as_str(), d.item.label.difficulty.as_str()), ("forge 9.9", "Reckless"));
    assert_eq!(d.item.forge_games.map(|g| (g.done, g.total)), Some((0, 100)));
    let (engines, max_seconds): (Vec<String>, Vec<i64>) = {
        let rows: Vec<(String, i64)> = sqlx::query_as("SELECT engine, json_extract(spec, '$.max_seconds') FROM lab_experiment_games WHERE experiment_id = ?")
            .bind(&d.item.id)
            .fetch_all(&pool)
            .await
            .unwrap();
        rows.into_iter().unzip()
    };
    assert!(engines.iter().all(|e| e == "forge"));
    assert!(max_seconds.iter().all(|s| *s == super::forge::FORGE_MAX_SECONDS as i64));
}

#[tokio::test]
async fn forge_games_go_to_the_forge_worker_and_never_to_the_lab_threads() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let f = FakeForge::new(&[]);
    let d = create_with(&pool, &user("admin", true), with_engine(swap_req(40), "forge"), sim.as_ref(), &crate::config::LabQuota::default(), &forge_access(&f))
        .await
        .unwrap();
    let worker = LabWorker::new_with_forge(pool.clone(), 2, SimState::Ready(sim.clone()), Some(f.clone() as Arc<dyn ForgeClient>));
    worker.drain().await;
    assert!(sim.played().is_empty(), "the lab threads play phase games only");
    assert_eq!(detail(&pool, "admin", &d.item.id).await.unwrap().item.progress.done, 0);
    worker.drain_forge().await;
    let played = f.played.lock().unwrap().clone();
    assert_eq!(played.len(), 40);
    // The worker gets each seat's list with the commander marked, and the run's profile.
    let p = &played[0];
    assert_eq!(p.decks.len(), p.spec.decks.len());
    assert_eq!(p.decks.iter().map(|d| d.id.clone()).collect::<Vec<_>>(), p.spec.decks);
    assert!(p.decks.iter().all(|d| d.cards.iter().filter(|c| c.commander).count() == 1));
    assert_eq!(p.profile, "Default");
    assert_eq!(p.key, format!("{}/{}", d.item.id, p.spec.game));
    let done = detail(&pool, "admin", &d.item.id).await.unwrap();
    assert_eq!((done.item.status.as_str(), done.item.progress.done), ("done", 40));
    assert_eq!(done.item.label.engine, "forge 9.9");
    assert!(done.item.summary_forge.is_none(), "a Forge-only run keeps its one summary");
    let s = done.item.summary.unwrap();
    assert_eq!(s.paired.pods, 20);
    assert_eq!(s.paired.variant_only + s.paired.base_only, 0, "the fake Forge plays both lists alike");
    assert_eq!(worker.forge_view().engine.as_deref(), Some("forge 9.9"));
    assert!(worker.forge_view().online);
}

#[tokio::test]
async fn both_engines_play_every_pod_and_their_results_stay_apart() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let f = FakeForge::new(&[]);
    // A named seed, so the verdicts below are the same every run: of its 50 pods the fake sim
    // gives the changed list alone 11, which reads as better. With a random seed 3 or fewer came
    // up about once in 175 runs, the interval's low end rounded to 0, and Phase's verdict was
    // "can't tell" (stream K's CI, 12 Nov 2026).
    super::experiments::test_seed::set(VERDICT_SEED);
    let d = create_with(&pool, &user("bryan", false), with_engine(swap_req(100), "both"), sim.as_ref(), &crate::config::LabQuota::default(), &forge_access(&f))
        .await
        .unwrap();
    assert_eq!(d.seed, VERDICT_SEED);
    assert_eq!(d.item.progress.total, 200);
    assert_eq!(d.item.label.engine, format!("{ENGINE}, forge 9.9"));
    // Each phase game has a Forge twin: the same seed and seats, its own id, after every phase game.
    let rows: Vec<(String, i64, String, String)> = sqlx::query_as("SELECT game, ord, spec, engine FROM lab_experiment_games WHERE experiment_id = ? ORDER BY ord")
        .bind(&d.item.id)
        .fetch_all(&pool)
        .await
        .unwrap();
    let phase: Vec<_> = rows.iter().filter(|r| r.3 == "phase").collect();
    let forge: Vec<_> = rows.iter().filter(|r| r.3 == "forge").collect();
    assert_eq!((phase.len(), forge.len()), (100, 100));
    assert!(phase.iter().map(|r| r.1).max() < forge.iter().map(|r| r.1).min());
    assert_eq!(forge[0].1 % 2, 0, "pods stay adjacent in the Forge half");
    for (p, f) in phase.iter().zip(&forge) {
        assert_eq!(f.0, format!("{}-f", p.0));
        let (ps, fs): (GameSpec, GameSpec) = (serde_json::from_str(&p.2).unwrap(), serde_json::from_str(&f.2).unwrap());
        assert_eq!((ps.seed, &ps.decks), (fs.seed, &fs.decks));
        assert_eq!(fs.game, f.0);
    }
    let worker = LabWorker::new_with_forge(pool.clone(), 2, SimState::Ready(sim.clone()), Some(f.clone() as Arc<dyn ForgeClient>));
    worker.drain().await;
    let half = detail(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!((half.item.status.as_str(), half.item.progress.done), ("running", 100));
    assert!(half.item.summary.as_ref().unwrap().verdict.is_final, "phase's half is complete");
    assert_eq!(half.item.agreement.as_ref().map(|a| a.kind), Some(super::stats::AgreementKind::Waiting), "nothing to compare until Forge's half has results");
    // While Forge's half waits, the run shows the worker's state.
    let mut item = half.item.clone();
    item.with_forge(&worker.forge_view());
    assert!(item.forge.is_some());
    worker.drain_forge().await;
    let done = detail(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!((done.item.status.as_str(), done.item.progress.done), ("done", 200));
    let (ps, fs) = (done.item.summary.clone().unwrap(), done.item.summary_forge.clone().unwrap());
    assert_eq!((ps.paired.pods, fs.paired.pods), (50, 50));
    assert!(ps.builds.iter().all(|b| b.build.engine == ENGINE));
    assert!(fs.builds.iter().all(|b| b.build.engine == "forge 9.9"));
    // Phase says better (the fake sim favours the change); the fake Forge sees no difference.
    assert_eq!((ps.paired.variant_only, ps.paired.base_only), (11, 0), "the pods this seed deals");
    assert_eq!(ps.verdict.kind, VerdictKind::Better, "{}", ps.verdict.text);
    assert_eq!(fs.verdict.kind, VerdictKind::Unclear, "{}", fs.verdict.text);
    let a = done.item.agreement.unwrap();
    assert_ne!(a.kind, super::stats::AgreementKind::Waiting);
    assert!(done.item.label.engine.contains("forge 9.9") && done.item.label.engine.contains(ENGINE));
    // Each engine's pods, numbered from 1.
    let fp = pods_for(&pool, "bryan", &d.item.id, Some("forge")).await.unwrap();
    assert_eq!((fp.len(), fp[0].pod, fp.last().unwrap().pod), (50, 1, 50));
    assert!(fp.iter().all(|p| p.base.is_some() && p.variant.is_some()));
    let pp = pods_for(&pool, "bryan", &d.item.id, None).await.unwrap();
    assert_eq!(pp.len(), 50);
    assert!(pods_for(&pool, "other", &d.item.id, Some("forge")).await.is_err(), "someone else's run is not found");
    // Again keeps both engines.
    let again = again_with(&pool, &user("bryan", false), &d.item.id, 100, None, sim.as_ref(), &crate::config::LabQuota::default(), &forge_access(&f)).await.unwrap();
    assert_eq!((again.item.engines.mode, again.item.progress.total), (super::forge::EngineMode::Both, 200));
}

#[tokio::test]
async fn cards_forge_doesnt_know_are_refused_and_left_out_of_a_forge_field() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let quota = crate::config::LabQuota::default();
    let bryan = user("bryan", false);
    // Forge doesn't know Grizzly Bears or Atla (p2's commander).
    let f = FakeForge::new(&["Grizzly Bears", "Atla"]);
    let mut r = swap_req(100);
    r.variant.add = vec!["Grizzly Bears".into(), "Elvish Mystic".into()];
    let (msg, details) = invalid(create_with(&pool, &bryan, with_engine(r, "forge"), sim.as_ref(), &quota, &forge_access(&f)).await.unwrap_err());
    assert!(msg.contains("Forge can't play") && msg.contains("Grizzly Bears"), "{msg}");
    assert_eq!(details["engine"], "forge");
    assert_eq!(details["unknown"]["variant"], json!(["Grizzly Bears"]));
    // The same change on phase is fine.
    let mut r = swap_req(100);
    r.variant.add = vec!["Grizzly Bears".into(), "Elvish Mystic".into()];
    create_with(&pool, &bryan, r, sim.as_ref(), &quota, &forge_access(&f)).await.unwrap();
    // A Forge field leaves out the precon Forge can't play, and says so.
    let d = create_with(&pool, &user("admin", true), with_engine(swap_req(100), "both"), sim.as_ref(), &quota, &forge_access(&f)).await.unwrap();
    let ids: Vec<&str> = d.opponents.iter().map(|o| o.id.as_str()).collect();
    assert!(!ids.contains(&"precons/p2"), "{ids:?}");
    assert!(d.warnings.iter().any(|w| w.contains("Left out") && w.contains("Precon p2")), "{:?}", d.warnings);
    assert!(f.checked.load(Ordering::SeqCst) > 0);
    // With the worker offline nothing is checked: the run is made, and says so.
    let offline = ForgeAccess { cards: None, engine: None, ..forge_access(&f) };
    let d = create_with(&pool, &user("admin", true), with_engine(swap_req(100), "forge"), sim.as_ref(), &quota, &offline).await.unwrap();
    assert!(d.warnings.iter().any(|w| w.contains("offline")), "{:?}", d.warnings);
}

#[tokio::test]
async fn an_offline_forge_worker_is_handed_nothing_and_a_lost_game_is_written_off_after_three_tries() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let f = FakeForge::new(&[]);
    let d = create_with(&pool, &user("bryan", false), with_engine(swap_req(100), "forge"), sim.as_ref(), &crate::config::LabQuota::default(), &forge_access(&f))
        .await
        .unwrap();
    let worker = LabWorker::new_with_forge(pool.clone(), 2, SimState::Ready(sim.clone()), Some(f.clone() as Arc<dyn ForgeClient>));
    f.offline.store(true, Ordering::SeqCst);
    assert_eq!(worker.forge_tick().await.unwrap(), 0);
    let view = worker.forge_view();
    assert!(view.configured && !view.online && view.error.as_deref() == Some("connection refused"), "{view:?}");
    let attempts: i64 = sqlx::query_scalar("SELECT MAX(attempts) FROM lab_experiment_games WHERE experiment_id = ?").bind(&d.item.id).fetch_one(&pool).await.unwrap();
    assert_eq!(attempts, 0, "nothing is claimed while the worker doesn't answer");
    // Back online, but every game it's handed is lost: each goes back in the queue, then is
    // written off after FORGE_MAX_ATTEMPTS tries.
    f.offline.store(false, Ordering::SeqCst);
    f.lose_games.store(true, Ordering::SeqCst);
    worker.drain_forge().await;
    let played = f.played.lock().unwrap().clone();
    let tries = played.iter().filter(|p| p.spec.game == played[0].spec.game).count();
    assert_eq!(tries as i64, super::forge::FORGE_MAX_ATTEMPTS);
    let done = detail(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!(done.item.status, "failed");
    let errors: Vec<Option<String>> = sqlx::query_scalar("SELECT json_extract(result, '$.error') FROM lab_experiment_games WHERE experiment_id = ? LIMIT 3")
        .bind(&d.item.id)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(errors.iter().all(|e| e.as_deref().is_some_and(|e| e.contains("handed to the Forge worker 3 times"))), "{errors:?}");
    let engine: String = sqlx::query_scalar("SELECT json_extract(result, '$.engine') FROM lab_experiment_games WHERE experiment_id = ? LIMIT 1")
        .bind(&d.item.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(engine, "forge 9.9", "a written-off Forge game is labelled as Forge");
}

#[tokio::test]
async fn forge_games_count_double_against_the_daily_allowance() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let f = FakeForge::new(&[]);
    let newbie = add_open_user(&pool, "newbie").await;
    let quota = crate::config::LabQuota { queue_games: 2_000, open_queue_games: 400, open_daily_games: 300, ..Default::default() };
    let first = create_with(&pool, &newbie, with_engine(swap_req(100), "forge"), sim.as_ref(), &quota, &forge_access(&f)).await.unwrap();
    let used: i64 = sqlx::query_scalar("SELECT SUM(games) FROM lab_usage WHERE owner_id = 'newbie'").fetch_one(&pool).await.unwrap();
    assert_eq!(used, 100 * i64::from(super::forge::FORGE_WEIGHT));
    cancel(&pool, "newbie", &first.item.id, &idle).await.unwrap();
    let e = create_with(&pool, &newbie, with_engine(swap_req(100), "forge"), sim.as_ref(), &quota, &forge_access(&f)).await.unwrap_err();
    assert!(matches!(&e, AppError::Conflict(m) if m.contains("300 games a day")), "{e:?}");
    // A phase run still fits.
    create_with(&pool, &newbie, swap_req(100), sim.as_ref(), &quota, &forge_access(&f)).await.unwrap();
}

// ── games the machine cut short, and adding games to a run (2026-10-23) ─────

use super::worker::EarlierTry;

/// Plays as [`FakeSim`] does, except: games whose ids end in a key of `first_try` end that way on
/// their first try (then play normally), games ending in `always` time out every time, and
/// `earlier` answers [`Simulator::earlier_try`] for the game ids it names.
struct CutSim {
    inner: Arc<FakeSim>,
    first_try: HashMap<String, (End, Option<String>)>,
    always: Vec<String>,
    earlier: Mutex<HashMap<String, EarlierTry>>,
    tries: Mutex<HashMap<String, usize>>,
}

impl CutSim {
    fn new(first_try: &[(&str, End, Option<&str>)], always: &[&str]) -> Arc<Self> {
        Arc::new(CutSim {
            inner: FakeSim::new(),
            first_try: first_try.iter().map(|(g, e, why)| (g.to_string(), (*e, why.map(String::from)))).collect(),
            always: always.iter().map(|s| s.to_string()).collect(),
            earlier: Mutex::default(),
            tries: Mutex::default(),
        })
    }
    fn tries(&self, suffix: &str) -> usize {
        self.tries.lock().unwrap().iter().filter(|(g, _)| g.ends_with(suffix)).map(|(_, n)| *n).sum()
    }
}

impl Simulator for CutSim {
    fn card_data(&self) -> String {
        self.inner.card_data()
    }
    fn unknown(&self, cards: &[LabCard]) -> Vec<String> {
        self.inner.unknown(cards)
    }
    fn earlier_try(&self, game: &str) -> EarlierTry {
        self.earlier.lock().unwrap().remove(game).unwrap_or(EarlierTry::Unknown)
    }
    fn play(&self, spec: &GameSpec, decks: &[Arc<LabList>], limits: &Limits) -> GameResult {
        let n = {
            let mut tries = self.tries.lock().unwrap();
            let n = tries.entry(spec.game.clone()).or_default();
            *n += 1;
            *n
        };
        let mut r = self.inner.play(spec, decks, limits);
        let cut = |r: &mut GameResult, end: End, why: Option<String>| {
            r.end = end;
            r.error = why;
            r.winner = None;
            r.placements = vec![];
            r.turns = 7;
        };
        if self.always.iter().any(|s| spec.game.ends_with(s.as_str())) {
            cut(&mut r, End::TimeCap, None);
        } else if n == 1
            && let Some((end, why)) = self.first_try.iter().find(|(s, _)| spec.game.ends_with(s.as_str())).map(|(_, v)| v.clone())
        {
            cut(&mut r, end, why);
        }
        r
    }
}

#[tokio::test]
async fn games_the_machine_cut_short_play_once_more_after_the_rest() {
    let pool = fixture().await;
    let sim = CutSim::new(
        &[
            ("-3-base", End::TimeCap, None),
            ("-5-variant", End::Error, Some("hung: no move for 300s, stuck inside one engine or AI step")),
            ("-6-base", End::Error, Some("wall-clock safety limit: 2400s elapsed")),
            // Not the machine: a game that can't be played is stored at once, never replayed.
            ("-8-base", End::Error, Some("AI for seat 1 found no action")),
        ],
        &["-7-variant"],
    );
    let d = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    assert_eq!((sim.tries("-3-base"), sim.tries("-5-variant"), sim.tries("-6-base")), (2, 2, 2));
    assert_eq!((sim.tries("-7-variant"), sim.tries("-8-base"), sim.tries("-9-base")), (2, 1, 1));
    // The retries came after every other game.
    let played = sim.inner.played();
    assert_eq!(played.len(), 104);
    assert!(played[100..].iter().all(|(s, _)| ["-3-base", "-5-variant", "-6-base", "-7-variant"].iter().any(|x| s.game.ends_with(x))));
    let done = detail(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!((done.item.status.as_str(), done.item.progress.done), ("done", 100));
    let s = done.item.summary.unwrap();
    // Only the game that times out every time and the unplayable one are left unscored.
    assert_eq!((s.unscored.time_cap, s.unscored.error, s.paired.pods), (1, 1, 48));
    let end_of = |suffix: &str| {
        let pool = pool.clone();
        let game = format!("{}{suffix}", &d.item.id[..8]);
        async move { sqlx::query_scalar::<_, String>("SELECT end_kind FROM lab_experiment_games WHERE game = ?").bind(game).fetch_one(&pool).await.unwrap() }
    };
    assert_eq!(end_of("-3-base").await, "win");
    assert_eq!(end_of("-7-variant").await, "time_cap");
}

#[tokio::test]
async fn a_hung_games_retry_keeps_its_late_result_and_isnt_replayed_while_still_stuck() {
    let pool = fixture().await;
    let hung = Some("hung: no move for 300s, stuck inside one engine or AI step");
    let sim = CutSim::new(&[("-1-base", End::Error, hung), ("-2-base", End::Error, hung)], &[]);
    let d = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    let prefix = d.item.id[..8].to_string();
    // The first try of pod 1's base game finished after all, as a win at turn 77; pod 2's is
    // still stuck.
    let spec: String = sqlx::query_scalar("SELECT spec FROM lab_experiment_games WHERE game = ?").bind(format!("{prefix}-1-base")).fetch_one(&pool).await.unwrap();
    let spec: GameSpec = serde_json::from_str(&spec).unwrap();
    let mut late = GameResult::new(&spec, "fakecarddata0000");
    let seat = spec.decks.iter().position(|x| x == BASE_ID).unwrap() as u8;
    late.end = End::Win;
    late.winner = Some(seat);
    late.placements = vec![vec![seat], (0..4).filter(|s| *s != seat).collect()];
    late.turns = 77;
    sim.earlier.lock().unwrap().insert(format!("{prefix}-1-base"), EarlierTry::Finished(late));
    sim.earlier.lock().unwrap().insert(format!("{prefix}-2-base"), EarlierTry::Playing);
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    assert_eq!((sim.tries("-1-base"), sim.tries("-2-base")), (1, 1), "neither is played a second time");
    let row = |g: String| {
        let pool = pool.clone();
        async move { sqlx::query_as::<_, (String, String)>("SELECT end_kind, result FROM lab_experiment_games WHERE game = ?").bind(g).fetch_one(&pool).await.unwrap() }
    };
    let (end, line) = row(format!("{prefix}-1-base")).await;
    assert_eq!(end, "win");
    assert_eq!(serde_json::from_str::<GameResult>(&line).unwrap().turns, 77);
    let (end, line) = row(format!("{prefix}-2-base")).await;
    assert_eq!(end, "error");
    assert!(serde_json::from_str::<GameResult>(&line).unwrap().error.unwrap().contains("still stuck"));
    assert_eq!(detail(&pool, "bryan", &d.item.id).await.unwrap().item.status, "done");
}

#[tokio::test]
async fn more_games_continue_the_schedule_and_pool_with_the_results_so_far() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let bryan = user("bryan", false);
    let d = create(&pool, &bryan, swap_req(100), sim.as_ref()).await.unwrap();
    let id = d.item.id.clone();
    // Not while it plays.
    assert!(matches!(more(&pool, &bryan, &id, 100, 50, sim.as_ref()).await.unwrap_err(), AppError::Conflict(_)));
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    let before = detail(&pool, "bryan", &id).await.unwrap();
    let seeds_before: HashSet<u64> = sim.played().iter().map(|(s, _)| s.seed).collect();
    assert!(matches!(more(&pool, &user("other", false), &id, 100, 50, sim.as_ref()).await.unwrap_err(), AppError::NotFound(_)));
    assert!(bad(more(&pool, &bryan, &id, 150, 50, sim.as_ref()).await.unwrap_err()).contains("games must be"));
    let added = more(&pool, &bryan, &id, 200, 50, sim.as_ref()).await.unwrap();
    assert_eq!((added.item.status.as_str(), added.item.progress.done, added.item.progress.total), ("queued", 100, 300));
    assert_eq!(added.item.label.games, 300);
    assert!(!added.item.summary.as_ref().unwrap().verdict.is_final, "the summary waits for the new games");
    assert_eq!(added.item.label.finished_at, None);
    // The same request again (the page retried it) adds nothing.
    let again = more(&pool, &bryan, &id, 200, 50, sim.as_ref()).await.unwrap();
    assert_eq!(again.item.progress.total, 300);
    worker.drain().await;
    let played = sim.played();
    assert_eq!(played.len(), 300);
    // New pods 50 to 149: new ids and shuffles, the same pairing.
    let ids: HashSet<&str> = played.iter().map(|(s, _)| s.game.as_str()).collect();
    assert_eq!(ids.len(), 300);
    for t in 50..150 {
        assert!(ids.contains(format!("{}-{t}-base", &id[..8]).as_str()) && ids.contains(format!("{}-{t}-variant", &id[..8]).as_str()));
    }
    let new_seeds: HashSet<u64> = played[100..].iter().map(|(s, _)| s.seed).collect();
    assert!(new_seeds.is_disjoint(&seeds_before));
    let done = detail(&pool, "bryan", &id).await.unwrap();
    assert_eq!((done.item.status.as_str(), done.item.progress.done), ("done", 300));
    let s = done.item.summary.unwrap();
    assert_eq!((s.pods, s.paired.pods), (150, 150));
    assert!(s.verdict.is_final);
    assert_eq!(done.opponents.iter().map(|o| o.pods).sum::<usize>(), 150 * 3);
    assert_eq!(before.item.summary.unwrap().pods, 50);
    let pods = pods_for(&pool, "bryan", &id, None).await.unwrap();
    assert_eq!((pods.len(), pods.last().unwrap().pod), (150, 150));
    // A run played on another phase engine can't take more games.
    sqlx::query("UPDATE lab_experiment_games SET result = json_set(result, '$.engine', 'phase-rs v0.112.0') WHERE experiment_id = ? AND ord = 0")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    let e = more(&pool, &bryan, &id, 100, 150, sim.as_ref()).await.unwrap_err();
    assert!(matches!(&e, AppError::Conflict(m) if m.contains("earlier Phase engine")), "{e:?}");
}

#[tokio::test]
async fn more_games_on_both_engines_keep_each_engines_pods_in_order() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let f = FakeForge::new(&[]);
    let quota = crate::config::LabQuota::default();
    let bryan = user("bryan", false);
    let d = create_with(&pool, &bryan, with_engine(swap_req(100), "both"), sim.as_ref(), &quota, &forge_access(&f)).await.unwrap();
    let id = d.item.id.clone();
    let worker = LabWorker::new_with_forge(pool.clone(), 2, SimState::Ready(sim.clone()), Some(f.clone() as Arc<dyn ForgeClient>));
    worker.drain().await;
    worker.drain_forge().await;
    let added = more_with(&pool, &bryan, &id, 100, 50, sim.as_ref(), &quota, &forge_access(&f)).await.unwrap();
    assert_eq!(added.item.progress.total, 400);
    worker.drain().await;
    worker.drain_forge().await;
    let done = detail(&pool, "bryan", &id).await.unwrap();
    assert_eq!((done.item.status.as_str(), done.item.progress.done), ("done", 400));
    let (ps, fs) = (done.item.summary.unwrap(), done.item.summary_forge.unwrap());
    assert_eq!((ps.pods, ps.paired.pods, fs.pods, fs.paired.pods), (100, 100, 100, 100));
    for engine in ["phase", "forge"] {
        let pods = pods_for(&pool, "bryan", &id, Some(engine)).await.unwrap();
        assert_eq!(pods.iter().map(|p| p.pod).collect::<Vec<_>>(), (1..=100).collect::<Vec<_>>(), "{engine}");
        assert!(pods.iter().all(|p| p.base.is_some() && p.variant.is_some()), "{engine}");
    }
    // Every Forge game is its phase twin's copy.
    let rows: Vec<(String, i64, String)> = sqlx::query_as("SELECT game, ord, engine FROM lab_experiment_games WHERE experiment_id = ?").bind(&id).fetch_all(&pool).await.unwrap();
    let ord: HashMap<&str, i64> = rows.iter().map(|(g, o, _)| (g.as_str(), *o)).collect();
    for (g, o, e) in &rows {
        if e == "phase" {
            assert_eq!(ord[format!("{g}-f").as_str()], o + 100, "{g}");
        }
    }
}

#[tokio::test]
async fn finished_summaries_from_before_the_settle_estimate_are_rewritten_once() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let d = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    let has_key = || {
        let pool = pool.clone();
        let id = d.item.id.clone();
        async move {
            sqlx::query_scalar::<_, Option<String>>("SELECT json_type(summary, '$.paired.settle_pods') FROM lab_experiments WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap()
        }
    };
    assert!(has_key().await.is_some());
    assert_eq!(worker.resummarize_old().await.unwrap(), 0);
    sqlx::query("UPDATE lab_experiments SET summary = json_remove(summary, '$.paired.settle_pods')").execute(&pool).await.unwrap();
    assert!(has_key().await.is_none());
    assert_eq!(worker.resummarize_old().await.unwrap(), 1);
    assert!(has_key().await.is_some());
    let after = detail(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!(after.item.status, "done");
    assert!(after.item.summary.unwrap().verdict.is_final);
}

/// Claude's lab tools (mcp/tools.rs, mcp/changes.rs) on the fake engine: staged runs of each kind,
/// what lab_run and lab_games read back, and adding games, running again and cancelling.
#[tokio::test]
async fn claude_can_start_read_extend_repeat_and_cancel_lab_runs() {
    use crate::mcp::{Via, changes, tools};
    let pool = fixture().await;
    let sim = FakeSim::new();
    let mut st = crate::testutil::state_with(crate::testutil::config(), pool.clone()).await;
    st.lab = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    let bryan = user("bryan", false);
    let call = |name: &'static str, args: Value| {
        let (st, bryan) = (st.clone(), bryan.clone());
        async move { tools::call(&st, &bryan, &Via::Key, name, &args).await }
    };
    let change_id = |text: &str| text.lines().find_map(|l| l.strip_prefix("Change id: ")).unwrap().to_string();
    let payload = |id: String| {
        let pool = pool.clone();
        async move {
            let p: String = sqlx::query_scalar("SELECT payload FROM assistant_changes WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap();
            serde_json::from_str::<Value>(&p).unwrap()
        }
    };

    // Each mode stages the request the lab's pages would send; nothing is made yet.
    let compare = call("start_lab_run", json!({"mode": "compare", "deck": "p1", "other": "Precon p2", "engine": "phase", "ai": "Medium"})).await.unwrap();
    assert!(compare.contains("Lab run, Precon p1 against Precon p2"), "{compare}");
    let p = payload(change_id(&compare)).await;
    assert_eq!((p["mode"].as_str(), p["base"]["id"].as_str(), p["other"]["id"].as_str(), p["difficulty"].as_str()), (Some("compare"), Some("p1"), Some("p2"), Some("Medium")));
    let versus = call("start_lab_run", json!({"mode": "versus", "entrants": ["p1", "p2"], "pod": 2})).await.unwrap();
    let p = payload(change_id(&versus)).await;
    assert_eq!((p["entrants"].as_array().unwrap().len(), p["pod"].as_u64(), p.get("field")), (2, Some(2), None));
    let solo = call("start_lab_run", json!({"mode": "solo", "deck": "p1", "opponents": "similar", "near": "p3"})).await.unwrap();
    assert_eq!(payload(change_id(&solo)).await["field"], json!({"kind": "precons_near", "n": DEFAULT_FIELD, "ids": ["p3"]}));
    assert!(call("start_lab_run", json!({"mode": "solo", "deck": "p1", "add": ["Sol Ring"]})).await.unwrap_err().to_string().contains("as it is"));
    assert!(call("start_lab_run", json!({"deck": "No Such Deck", "add": ["Sol Ring"]})).await.unwrap_err().to_string().contains("No deck of theirs"));
    assert!(call("start_lab_run", json!({"deck": "p1", "add": ["Sol Ring"], "games": 150})).await.unwrap_err().to_string().contains("games must be"));
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_experiments").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0);

    // A change, applied and played.
    let staged = call(
        "start_lab_run",
        json!({"deck": "p1", "add": ["Llanowar Elves", "Elvish Mystic"], "cut": ["Forest", "Forest"], "opponents": "strongest", "games": 100}),
    )
    .await
    .unwrap();
    let applied = changes::apply(&st, &bryan, &change_id(&staged)).await.unwrap();
    assert_eq!(applied.status, "applied", "{:?}", applied.error);
    let id = applied.result.unwrap()["link"].as_str().unwrap().rsplit('/').next().unwrap().to_string();
    st.lab.drain().await;

    let run = call("lab_run", json!({"id": id})).await.unwrap();
    for part in ["Mode: try a change", "Engines: phase, Easy AI", "Results on phase:", "50 pods scheduled; 50 count in the difference", "Difference (the changed list minus the base list)", "Every game played so far was scored.", "Verdict: "] {
        assert!(run.contains(part), "{part:?} missing from:\n{run}");
    }
    assert!(!run.contains("\"wilson\""), "plain words, not the summary's JSON");

    let games = call("lab_games", json!({"id": id})).await.unwrap();
    assert!(games.starts_with("50 pods on phase."), "{games}");
    assert!(games.contains(&format!("- Pod 1 (tested seat ")) && games.contains(&format!("[{}-0-base]", &id[..8])), "{games}");
    assert!(call("lab_games", json!({"id": id, "only": "unscored"})).await.unwrap().starts_with("0 pods on phase with a game that wasn't scored (of 50)."));
    let one = call("lab_games", json!({"id": id, "game": format!("{}-0-variant", &id[..8])})).await.unwrap();
    for part in ["Schedule line:\n{", "Result line:\n{", "Seat 1: ", "Commander\n1 Ghave\n", "To replay:"] {
        assert!(one.contains(part), "{part:?} missing from:\n{one}");
    }
    let other = user("other", false);
    assert!(matches!(tools::call(&st, &other, &Via::Key, "lab_games", &json!({"id": id})).await.unwrap_err(), AppError::NotFound(_)));
    assert!(matches!(tools::call(&st, &other, &Via::Key, "more_lab_games", &json!({"id": id})).await.unwrap_err(), AppError::NotFound(_)));

    // More games: staged against the pods it saw, so a second change staged at the same time can't
    // add them twice.
    let more1 = call("more_lab_games", json!({"id": id, "games": 200})).await.unwrap();
    let more2 = call("more_lab_games", json!({"id": id, "games": 200})).await.unwrap();
    assert!(more1.contains("50 pods so far, then 100 more"), "{more1}");
    assert_eq!(changes::apply(&st, &bryan, &change_id(&more1)).await.unwrap().status, "applied");
    let stale = changes::apply(&st, &bryan, &change_id(&more2)).await.unwrap();
    assert_eq!(stale.status, "pending");
    assert!(stale.error.unwrap().contains("150 pods now"));
    assert!(call("more_lab_games", json!({"id": id})).await.unwrap_err().to_string().contains("this one is queued"));
    st.lab.drain().await;
    assert!(call("lab_run", json!({"id": id})).await.unwrap().contains("150 pods scheduled; 150 count"));

    // Again: a new run with the same lists; cancelling it.
    let again = call("run_lab_again", json!({"id": id})).await.unwrap();
    assert!(again.contains(": 400 games"), "300 isn't a choice, so the next one up: {again}");
    let again = changes::apply(&st, &bryan, &change_id(&again)).await.unwrap();
    let new_id = again.result.unwrap()["link"].as_str().unwrap().rsplit('/').next().unwrap().to_string();
    assert_ne!(new_id, id);
    let cancel = call("cancel_lab_run", json!({"id": new_id})).await.unwrap();
    let cancelled = changes::apply(&st, &bryan, &change_id(&cancel)).await.unwrap();
    assert_eq!(cancelled.status, "applied", "{:?}", cancelled.error);
    st.lab.drain().await;
    assert_eq!(detail(&pool, "bryan", &new_id).await.unwrap().item.status, "cancelled");
    assert!(call("cancel_lab_run", json!({"id": new_id})).await.unwrap_err().to_string().contains("nothing to cancel"));
}

#[tokio::test]
async fn tournament_is_one_frozen_shared_field_and_scores_every_deck() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let admin = user("admin", true);
    let r = req(json!({"op_id":"one-tournament", "mode":"tournament", "entrants": [
        {"kind":"precon","id":"p1"}, {"kind":"precon","id":"p2"},
        {"kind":"precon","id":"p3"}, {"kind":"precon","id":"p4"},
        {"kind":"precon","id":"p5"}, {"kind":"precon","id":"p1"}
    ], "games":100}));
    let d = create(&pool, &admin, r, sim.as_ref()).await.unwrap();
    assert_eq!(d.item.mode, Mode::Tournament);
    assert_eq!(d.games_per_deck, Some(100));
    assert_eq!(d.lists.entrants.len(), 5, "identical lists are not overweighted");
    assert!(d.warnings.iter().any(|w| w.contains("identical")));
    assert_eq!(d.item.progress.total, 128, "100 appearances per deck, rounded to whole seat rotations");
    let charged: i64 = sqlx::query_scalar("SELECT games FROM lab_usage WHERE experiment_id=?").bind(&d.item.id).fetch_one(&pool).await.unwrap();
    assert_eq!(charged, 128, "charge the total scheduled games, not the per-deck target");
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    let done = detail(&pool, "admin", &d.item.id).await.unwrap();
    let summary = done.item.summary.unwrap();
    assert!(summary.method.contains("tournament"));
    let v = summary.versus.unwrap();
    assert_eq!(v.games, 128);
    assert_eq!(v.entrants.iter().map(|e| e.games).sum::<u32>(), 512);
    assert!(v.entrants.iter().all(|e| (100..=104).contains(&e.games)));
    assert_eq!(v.entrants.iter().map(|e| e.wins).sum::<u32>(), 128);
    assert_eq!(v.meetings.iter().map(|m| m.games).sum::<u32>(), 128*6);
    assert!(detail(&pool,"other",&d.item.id).await.is_err());
    let again = again(&pool, &admin, &d.item.id, 200, Some("tournament-again"), sim.as_ref()).await.unwrap();
    assert_eq!(again.games_per_deck, Some(200));
    assert_eq!(again.item.progress.total, 252);
}

#[tokio::test]
async fn tables_group_a_tournament_by_table_with_each_seat_for_the_owner_only() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let admin = user("admin", true);
    let r = req(json!({"op_id":"tables-tournament", "mode":"tournament", "entrants": [
        {"kind":"precon","id":"p1"}, {"kind":"precon","id":"p2"},
        {"kind":"precon","id":"p3"}, {"kind":"precon","id":"p4"}, {"kind":"precon","id":"p5"}
    ], "games":8}));
    let d = create(&pool, &admin, r, sim.as_ref()).await.unwrap();
    let before = tables_for(&pool, "admin", &d.item.id, None, None, None).await.unwrap();
    assert!(before.tables.iter().flat_map(|t| &t.games).all(|g| !g.played && g.places.len() == 4), "unplayed games are listed, empty");
    LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone())).drain().await;
    let all = tables_for(&pool, "admin", &d.item.id, None, None, None).await.unwrap();
    assert_eq!(all.engine, "phase");
    assert_eq!(all.tables.iter().map(|t| t.games.len()).sum::<usize>(), d.item.progress.total as usize);
    for (i, t) in all.tables.iter().enumerate() {
        assert_eq!(t.table, i + 1);
        assert_eq!(t.games.len(), 4, "a table is one seat rotation");
        let mut decks = t.decks.clone();
        decks.sort();
        for g in &t.games {
            let mut seats = g.seats.clone();
            seats.sort();
            assert_eq!(seats, decks, "every game of a table has its four decks");
            assert!(g.played && g.end.is_some());
            if g.scored {
                assert!(g.places.iter().all(Option::is_some));
            }
        }
    }
    assert_eq!(all.decks.len(), 5);
    assert!(all.decks.iter().all(|x| x.entrant.is_some() && !x.label.is_empty()));
    let one = tables_for(&pool, "admin", &d.item.id, None, Some("e2"), None).await.unwrap();
    assert!(!one.tables.is_empty() && one.tables.iter().all(|t| t.decks.iter().any(|x| x == "e2")));
    let with_e2: Vec<&TableView> = all.tables.iter().filter(|t| t.decks.iter().any(|x| x == "e2")).collect();
    assert_eq!(one.tables.iter().collect::<Vec<_>>(), with_e2, "exactly the tables e2 sat at, numbered as in the whole run");
    let third = tables_for(&pool, "admin", &d.item.id, None, None, Some(3)).await.unwrap();
    assert_eq!(third.tables.len(), 1);
    assert_eq!(third.tables[0], all.tables[2], "a table keeps its number when filtered");
    assert_eq!(third.decks.len(), 4, "only the decks it names");
    assert!(tables_for(&pool, "admin", &d.item.id, None, None, Some(0)).await.unwrap().tables.is_empty());
    assert!(tables_for(&pool, "admin", &d.item.id, None, None, Some(usize::MAX)).await.unwrap().tables.is_empty());
    assert!(tables_for(&pool, "other", &d.item.id, None, None, None).await.is_err());
    assert!(tables_for(&pool, "admin", &d.item.id, Some("nope"), None, None).await.is_err());
}

#[tokio::test]
async fn lab_games_reads_a_tournament_table_by_table() {
    use crate::mcp::{Via, tools};
    let pool = fixture().await;
    let sim = FakeSim::new();
    let mut st = crate::testutil::state_with(crate::testutil::config(), pool.clone()).await;
    st.lab = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    let admin = user("admin", true);
    let r = req(json!({"op_id":"mcp-tables", "mode":"tournament", "entrants": [
        {"kind":"precon","id":"p1"}, {"kind":"precon","id":"p2"},
        {"kind":"precon","id":"p3"}, {"kind":"precon","id":"p4"}, {"kind":"precon","id":"p5"}
    ], "games":8}));
    let d = create(&pool, &admin, r, sim.as_ref()).await.unwrap();
    st.lab.drain().await;
    let call = |args: Value| {
        let (st, admin) = (st.clone(), admin.clone());
        async move { tools::call(&st, &admin, &Via::Key, "lab_games", &args).await }
    };
    let by_name = call(json!({"id": d.item.id, "deck": "precon p3"})).await.unwrap();
    assert!(by_name.contains("where Precon p3 sat"), "{by_name}");
    assert!(by_name.contains("Table ") && by_name.contains("went first") && by_name.contains("1. "), "{by_name}");
    assert_eq!(by_name, call(json!({"id": d.item.id, "deck": "e2"})).await.unwrap(), "by name or entrant id");
    let one = call(json!({"id": d.item.id, "table": 2})).await.unwrap();
    assert!(one.starts_with("1 table on phase."), "{one}");
    assert_eq!(one.matches("\n- ").count(), 4, "a table's four games: {one}");
    assert!(call(json!({"id": d.item.id, "deck": "precon"})).await.unwrap_err().to_string().contains("matches 5 decks"));
    assert!(call(json!({"id": d.item.id, "deck": "nobody"})).await.unwrap_err().to_string().contains("No deck"));
    let other = user("other", false);
    assert!(matches!(tools::call(&st, &other, &Via::Key, "lab_games", &json!({"id": d.item.id, "deck": "e0"})).await.unwrap_err(), AppError::NotFound(_)));

    // Two decks with one name (versions of a saved deck keep its name): the name is ambiguous.
    let a = deck(&pool, "admin", "Twin", list_of("Ghave", &["Llanowar Elves"])).await;
    let b = deck(&pool, "admin", "Twin", list_of("Atla", &["Grizzly Bears"])).await;
    let r = req(json!({"op_id":"mcp-twins", "mode":"tournament", "entrants": [
        {"kind":"deck","id":a}, {"kind":"deck","id":b}, {"kind":"precon","id":"p1"}, {"kind":"precon","id":"p2"}
    ], "games":4}));
    let twins = create(&pool, &admin, r, sim.as_ref()).await.unwrap();
    st.lab.drain().await;
    let err = call(json!({"id": twins.item.id, "deck": "twin"})).await.unwrap_err().to_string();
    assert!(err.contains("matches 2 decks") && err.contains("(e0)") && err.contains("(e1)"), "{err}");
    assert!(call(json!({"id": twins.item.id, "deck": "E1"})).await.unwrap().contains("where Twin sat"));
}

#[tokio::test]
async fn tables_name_the_precons_filling_head_to_head_seats() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let admin = user("admin", true);
    let r = req(json!({"op_id":"tables-versus", "mode":"versus", "entrants": [
        {"kind":"precon","id":"p1"}, {"kind":"precon","id":"p2"}
    ], "field":{"kind":"precons_ids","ids":["p3","p4","p5"]}, "games":8}));
    let d = create(&pool, &admin, r, sim.as_ref()).await.unwrap();
    LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone())).drain().await;
    let t = tables_for(&pool, "admin", &d.item.id, None, None, None).await.unwrap();
    assert_eq!(t.tables.len(), 2);
    assert!(t.tables.iter().all(|x| x.games.len() == 4 && x.decks.iter().any(|d| d == "e0") && x.decks.iter().any(|d| d == "e1")));
    assert!(t.decks.iter().any(|x| x.entrant.is_none()), "the fillers are named too");
    // 1v1: tables of two, two games each.
    let r = req(json!({"op_id":"tables-1v1", "mode":"versus", "entrants": [{"kind":"precon","id":"p1"}, {"kind":"precon","id":"p2"}], "pod": 2, "games": 6}));
    let one = create(&pool, &admin, r, sim.as_ref()).await.unwrap();
    LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone())).drain().await;
    let t = tables_for(&pool, "admin", &one.item.id, None, None, None).await.unwrap();
    assert_eq!(t.tables.iter().map(|x| (x.table, x.games.len(), x.decks.len())).collect::<Vec<_>>(), [(1, 2, 2), (2, 2, 2), (3, 2, 2)]);
    assert_eq!(tables_for(&pool, "admin", &one.item.id, None, None, Some(2)).await.unwrap().tables, vec![t.tables[1].clone()]);
    // Change runs have no tables.
    let c = create(&pool, &admin, swap_req(20), sim.as_ref()).await.unwrap();
    assert!(tables_for(&pool, "admin", &c.item.id, None, None, None).await.is_err());
}

#[tokio::test]
async fn tournament_can_add_the_precon_catalog_and_preserves_idempotency() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let admin = user("admin", true);
    let request = || req(json!({"op_id":"catalog-tournament", "mode":"tournament", "entrants":[{"kind":"precon","id":"p1"}], "field":{"kind":"precons_all"}, "games":100}));
    let first = create(&pool,&admin,request(),sim.as_ref()).await.unwrap();
    let second = create(&pool,&admin,request(),sim.as_ref()).await.unwrap();
    assert_eq!(first.item.id, second.item.id);
    assert_eq!(first.lists.entrants.len(), 5, "supported catalog decks become scored entrants; unsupported p6 excluded");
    assert!(first.opponents.is_empty(), "no unscored filler decks in tournament mode");
    let too_few = req(json!({"mode":"tournament","entrants":[{"kind":"precon","id":"p1"}],"games":100}));
    assert!(bad(create(&pool,&admin,too_few,sim.as_ref()).await.unwrap_err()).contains("distinct decks"));
    let wrong_pod = req(json!({"mode":"tournament","pod":2,"entrants":[{"kind":"precon","id":"p1"}],"games":100}));
    assert!(bad(create(&pool,&admin,wrong_pod,sim.as_ref()).await.unwrap_err()).contains("four-player"));
}

#[tokio::test]
async fn tournament_charges_actual_games_and_rolls_back_when_allowance_is_too_small() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let mut limited = user("bryan", false);
    limited.limited = true;
    let quota = crate::config::LabQuota { open_daily_games: 100, ..Default::default() };
    let request = req(json!({"mode":"tournament","entrants":[{"kind":"precon","id":"p1"}],"field":{"kind":"precons_all"},"games":100}));
    let err = create_with(&pool,&limited,request,sim.as_ref(),&quota,&ForgeAccess::default()).await.unwrap_err();
    assert!(bad(err).contains("experiment limit"), "the five-deck tournament needs 128 games, not 100");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_experiments WHERE owner_id='bryan'").fetch_one(&pool).await.unwrap();
    assert_eq!(count,0,"no partial experiment or usage charge is committed");
}

#[tokio::test]
async fn tournament_progress_is_exact_between_summary_batches_and_cancel_flushes_it() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let admin = user("admin", true);
    let request = req(json!({"mode":"tournament","entrants":[{"kind":"precon","id":"p1"}],"field":{"kind":"precons_all"},"games":100}));
    let d = create(&pool,&admin,request,sim.as_ref()).await.unwrap();
    let (game, text): (String,String) = sqlx::query_as("SELECT game,spec FROM lab_experiment_games WHERE experiment_id=? ORDER BY ord LIMIT 1").bind(&d.item.id).fetch_one(&pool).await.unwrap();
    let spec: GameSpec = serde_json::from_str(&text).unwrap();
    let mut result = GameResult::new(&spec,"fake");
    result.end=End::Win; result.winner=Some(0); result.placements=vec![vec![0],vec![1,2,3]];
    assert!(store(&pool,&d.item.id,&game,&result).await.unwrap());
    assert!(!store(&pool,&d.item.id,&game,&result).await.unwrap());
    // A second game moments later is counted, but its summary waits for the batch.
    let (game2, text2): (String,String) = sqlx::query_as("SELECT game,spec FROM lab_experiment_games WHERE experiment_id=? ORDER BY ord LIMIT 1 OFFSET 1").bind(&d.item.id).fetch_one(&pool).await.unwrap();
    let spec2: GameSpec = serde_json::from_str(&text2).unwrap();
    let mut result2 = GameResult::new(&spec2,"fake");
    result2.end=End::Win; result2.winner=Some(0); result2.placements=vec![vec![0],vec![1,2,3]];
    assert!(store(&pool,&d.item.id,&game2,&result2).await.unwrap());
    let pending=detail(&pool,"admin",&d.item.id).await.unwrap();
    assert_eq!(pending.item.progress.done,2);
    assert_eq!(pending.item.summary.unwrap().versus.unwrap().games,1,"the summary is behind until its batch");
    let cancelled=cancel(&pool,"admin",&d.item.id,&idle).await.unwrap();
    assert_eq!(cancelled.item.progress.done,2);
    assert_eq!(cancelled.item.summary.unwrap().versus.unwrap().games,2,"cancel flushes the last partial summary batch");
}

#[tokio::test]
async fn retry_only_tail_exposes_owned_counts_and_hides_fast_pace_eta() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let bryan = user("bryan", false);
    let first = create(&pool, &bryan, swap_req(100), sim.as_ref()).await.unwrap();
    LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone())).drain().await;
    // Exclude the untouched fast fixture results: on a busy debug CI runner their
    // timestamps can otherwise fill the recent-40 window ahead of our paced sample.
    sqlx::query("UPDATE lab_experiment_games SET finished_at='2026-01-01T00:00:00Z' WHERE experiment_id=?")
        .bind(&first.item.id).execute(&pool).await.unwrap();
    let now = chrono::Utc::now();
    for (i, age) in [30, 20, 10, 0].into_iter().enumerate() {
        let at = (now - chrono::Duration::seconds(age)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        sqlx::query("UPDATE lab_experiment_games SET finished_at=? WHERE experiment_id=? AND ord=?")
            .bind(at).bind(&first.item.id).bind(i as i64).execute(&pool).await.unwrap();
    }
    let mine = create(&pool, &bryan, swap_req(100), sim.as_ref()).await.unwrap();
    let other = create(&pool, &user("other", false), swap_req(100), sim.as_ref()).await.unwrap();
    sqlx::query("UPDATE lab_experiment_games SET retried=1 WHERE experiment_id=?")
        .bind(&other.item.id).execute(&pool).await.unwrap();
    let initial = detail(&pool, "bryan", &mine.item.id).await.unwrap();
    assert_eq!((initial.item.progress.phase_pending, initial.item.progress.phase_retries), (100, 0));
    assert!(initial.item.progress.eta_seconds.is_some());
    // A later normal run cannot use fast-game pace through someone else's retry tail.
    let behind = create(&pool, &bryan, swap_req(100), sim.as_ref()).await.unwrap();
    assert_eq!(behind.item.progress.phase_retries, 0);
    assert_eq!(behind.item.progress.eta_seconds, None);
    // Mixed first attempts and retries still show counts without presenting other owners' counts.
    sqlx::query("UPDATE lab_experiment_games SET retried=1 WHERE experiment_id=? AND ord<2")
        .bind(&mine.item.id).execute(&pool).await.unwrap();
    let mixed = detail(&pool, "bryan", &mine.item.id).await.unwrap();
    assert_eq!((mixed.item.progress.phase_pending, mixed.item.progress.phase_retries), (100, 2));
    sqlx::query("UPDATE lab_experiment_games SET retried=1 WHERE experiment_id=?")
        .bind(&mine.item.id).execute(&pool).await.unwrap();
    let tail = detail(&pool, "bryan", &mine.item.id).await.unwrap();
    assert_eq!((tail.item.progress.phase_pending, tail.item.progress.phase_retries), (100, 100));
    assert_eq!(tail.item.progress.eta_seconds, None);
    assert!(detail(&pool, "other", &mine.item.id).await.is_err());
    LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone())).drain().await;
    let done = detail(&pool, "bryan", &mine.item.id).await.unwrap();
    assert_eq!((done.item.progress.phase_pending, done.item.progress.phase_retries), (0, 0));
}

#[tokio::test]
async fn retry_counts_are_not_lost_for_remotely_scheduled_experiments() {
    let pool = fixture().await;
    let d = create(&pool, &user("bryan", false), swap_req(100), FakeSim::new().as_ref()).await.unwrap();
    sqlx::query("UPDATE lab_experiment_games SET retried=1 WHERE experiment_id=?")
        .bind(&d.item.id).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO lab_execution_runs (id,experiment_id,owner_id,request_hash,comparison,target,created_at) VALUES ('remote-retries',?,'bryan','hash',0,'saget','now')")
        .bind(&d.item.id).execute(&pool).await.unwrap();
    let remote = detail(&pool, "bryan", &d.item.id).await.unwrap();
    assert_eq!((remote.item.progress.phase_pending, remote.item.progress.phase_retries), (100, 100));
    assert_eq!(remote.item.progress.eta_seconds, None);
}

#[tokio::test]
async fn cancelled_retry_tail_is_not_described_as_ongoing_in_advisor_context() {
    let pool = fixture().await;
    let bryan = user("bryan", false);
    let d = create(&pool, &bryan, swap_req(100), FakeSim::new().as_ref()).await.unwrap();
    sqlx::query("UPDATE lab_experiment_games SET retried=1 WHERE experiment_id=?")
        .bind(&d.item.id).execute(&pool).await.unwrap();
    let active = crate::advisor::context::build(&pool, &bryan, "experiment", Some(&d.item.id)).await.unwrap();
    assert!(active.contains("100 slow retries"));
    assert!(active.contains("retry-only tail"));
    for status in ["cancelled", "failed", "done"] {
        sqlx::query("UPDATE lab_experiments SET status=? WHERE id=?")
            .bind(status).bind(&d.item.id).execute(&pool).await.unwrap();
        let ended = crate::advisor::context::build(&pool, &bryan, "experiment", Some(&d.item.id)).await.unwrap();
        assert!(ended.contains(&format!("({status})")));
        assert!(!ended.contains("slow retries"));
        assert!(!ended.contains("retry-only tail"));
    }
}

#[tokio::test]
async fn stock_tournaments_pool_into_the_rating_simulation_one_engine_and_build_at_a_time() {
    use crate::precon_evidence::{choose_simulation, chosen_simulation, clear_simulation};
    let pool = fixture().await;
    let sim = FakeSim::new();
    let admin = user("admin", true);
    let tournament = |op: &str| req(json!({"op_id": op, "mode":"tournament","entrants":[{"kind":"precon","id":"p1"}],"field":{"kind":"precons_all"},"games":100}));
    let a = create(&pool, &admin, tournament("t-a"), sim.as_ref()).await.unwrap().item.id;
    let b = create(&pool, &admin, tournament("t-b"), sim.as_ref()).await.unwrap().item.id;
    LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone())).drain().await;
    assert!(chosen_simulation(&pool).await.unwrap().is_none(), "nothing chosen, no simulation");

    let build = choose_simulation(&pool, "admin", &[a.clone()], "phase", None).await.unwrap();
    assert!(!build.is_empty() && !build.contains('+'), "the newest game's engine version: {build}");
    let one = chosen_simulation(&pool).await.unwrap().expect("its phase games give strengths");
    assert_eq!(one.kind, "tournament");
    assert_eq!(one.precons, 5, "every stock entrant");
    assert!(one.name.starts_with("128 stock-precon tournament games"), "{}", one.name);
    assert!(!one.name.contains("Tournament:"), "the owner's experiment name stays private");
    assert_eq!(one.id, crate::precon_evidence::CHOSEN_SIMULATION_ID, "and so does its id");
    assert!(!one.engine.contains(&a));
    // Frozen at a date, as the time-split test sees it: no games had finished an hour ago.
    let past = chrono::Utc::now() - chrono::Duration::hours(1);
    assert!(crate::precon_evidence::chosen_simulation_at(&pool, Some(past)).await.unwrap().is_none());
    choose_simulation(&pool, "admin", &[a.clone(), b.clone()], "phase", None).await.unwrap();
    let both = chosen_simulation(&pool).await.unwrap().unwrap();
    assert!(both.name.starts_with("256 stock-precon tournament games"), "two tournaments pool: {}", both.name);
    assert_eq!(both.precons, 5, "one entrant per stock list across tournaments");

    // Another engine or engine version contributes nothing.
    assert!(choose_simulation(&pool, "admin", &[a.clone()], "forge", None).await.is_err(), "no forge games to name a build");
    assert!(choose_simulation(&pool, "admin", &[a.clone()], "phase", Some("phase-rs v9")).await.is_err(), "no games from that build");
    // Games from other card data drop out of a choice.
    sqlx::query("UPDATE precon_evidence_simulation SET card_data = 'other-card-data'").execute(&pool).await.unwrap();
    assert!(chosen_simulation(&pool).await.unwrap().is_none());
    assert!(choose_simulation(&pool, "admin", &[a.clone()], "mtga", None).await.is_err());
    assert!(choose_simulation(&pool, "bryan", &[a.clone()], "phase", None).await.is_err(), "only the operator's own tournaments");

    // Pods with a list that isn't a current stock precon drop out; the rest still count.
    choose_simulation(&pool, "admin", &[a.clone()], "phase", Some(&build)).await.unwrap();
    sqlx::query("UPDATE lab_experiments SET spec = json_set(spec, '$.entrants[0].sha256', 'not-stock') WHERE id = ?")
        .bind(&a)
        .execute(&pool)
        .await
        .unwrap();
    let fewer = chosen_simulation(&pool).await.unwrap().unwrap();
    let kept: u32 = fewer.name.split(' ').next().unwrap().parse().unwrap();
    assert!(kept > 0 && kept < 128, "{}", fewer.name);
    assert!(fewer.precons <= 4, "the altered list has no strength");
    clear_simulation(&pool).await.unwrap();
    assert!(chosen_simulation(&pool).await.unwrap().is_none());
}

#[tokio::test]
async fn progress_counts_every_game_while_summaries_are_rewritten_in_batches() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let d = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    let id = d.item.id.clone();
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT game, spec FROM lab_experiment_games WHERE experiment_id = ? ORDER BY ord").bind(&id).fetch_all(&pool).await.unwrap();
    let play = |i: usize| sim.play(&serde_json::from_str(&rows[i].1).unwrap(), &[], &LIMITS);
    let pending = |s: &Value| s["base"]["pending"].as_i64().unwrap() + s["variant"]["pending"].as_i64().unwrap();
    // The first result writes a summary; the next few, moments later, only count.
    for i in 0..10 {
        assert!(store(&pool, &id, &rows[i].0, &play(i)).await.unwrap());
    }
    let (done, s) = stored_summary(&pool, &id).await;
    assert_eq!(done, 10);
    assert_eq!(pending(&s), 99, "the summary is from the first result");
    // Twenty-five more since the last summary write another.
    for i in 10..26 {
        assert!(store(&pool, &id, &rows[i].0, &play(i)).await.unwrap());
    }
    let (done, s) = stored_summary(&pool, &id).await;
    assert_eq!((done, pending(&s)), (26, 74));
    // The last result always finishes the run.
    for i in 26..100 {
        assert!(store(&pool, &id, &rows[i].0, &play(i)).await.unwrap());
    }
    let done = detail(&pool, "bryan", &id).await.unwrap();
    assert_eq!((done.item.status.as_str(), done.item.progress.done), ("done", 100));
    let s = done.item.summary.unwrap();
    assert!(s.verdict.is_final);
    assert_eq!(s.base.pending + s.variant.pending, 0);
}

#[tokio::test]
async fn a_summary_made_from_older_results_never_undoes_progress_a_cancel_or_a_replay() {
    use super::worker::{Seen, make_summary, summary_inputs, write_summary};
    let pool = fixture().await;
    let sim = FakeSim::new();
    let d = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    let id = d.item.id.clone();
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT game, spec FROM lab_experiment_games WHERE experiment_id = ? ORDER BY ord").bind(&id).fetch_all(&pool).await.unwrap();
    let play = |i: usize| sim.play(&serde_json::from_str(&rows[i].1).unwrap(), &[], &LIMITS);
    sqlx::query("UPDATE lab_experiments SET status = 'running' WHERE id = ?").bind(&id).execute(&pool).await.unwrap();
    assert!(store(&pool, &id, &rows[0].0, &play(0)).await.unwrap());
    // Read and summarize, as `summarize` does outside a transaction...
    let read = || async {
        let inputs = summary_inputs(&mut *pool.acquire().await.unwrap(), &id).await.unwrap().unwrap();
        let seen = Seen { status: inputs.status.clone(), counted: inputs.counted, total: inputs.total };
        (make_summary(&inputs, false).unwrap(), seen)
    };
    let write = |made, seen| {
        let pool = pool.clone();
        let id = id.clone();
        async move { write_summary(&mut *pool.acquire().await.unwrap(), &id, &made, Some(&seen)).await.unwrap() }
    };
    let (made, seen) = read().await;
    // ...while another result is stored: it's still written (a busy run gets summaries), and the
    // progress count keeps the newer result.
    assert!(store(&pool, &id, &rows[1].0, &play(1)).await.unwrap());
    assert!(write(made, seen).await);
    let (done, s) = stored_summary(&pool, &id).await;
    assert_eq!(done, 2, "progress isn't put back");
    assert_eq!(s["base"]["pending"].as_i64().unwrap() + s["variant"]["pending"].as_i64().unwrap(), 99);
    // A replayed pod clears a result: one read before that isn't written.
    let (made, seen) = read().await;
    sqlx::query("UPDATE lab_experiment_games SET result = NULL WHERE experiment_id = ? AND game = ?").bind(&id).bind(&rows[1].0).execute(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    super::worker::refresh(&mut tx, &id, false).await.unwrap();
    tx.commit().await.unwrap();
    assert!(!write(made, seen).await);
    assert_eq!(stored_summary(&pool, &id).await.0, 1);
    // Nor is one read before a cancel, and a cancelled run isn't summarized out here at all.
    let (made, seen) = read().await;
    cancel(&pool, "bryan", &id, &idle).await.unwrap();
    let settled = stored_summary(&pool, &id).await.1;
    assert!(!write(made, seen).await);
    assert!(!super::worker::summarize(&pool, &id).await.unwrap());
    assert_eq!(stored_summary(&pool, &id).await.1, settled, "the cancel's final summary stays");
    assert_eq!(detail(&pool, "bryan", &id).await.unwrap().item.status, "cancelled");
}

#[tokio::test]
async fn a_run_whose_games_are_all_in_is_finished_even_if_its_last_summary_failed() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let d = create(&pool, &user("admin", true), swap_req(4), sim.as_ref()).await.unwrap();
    let worker = LabWorker::new(pool.clone(), 2, SimState::Ready(sim.clone()));
    worker.drain().await;
    assert_eq!(detail(&pool, "admin", &d.item.id).await.unwrap().item.status, "done");
    // As if the last summary had failed after the last result was stored.
    sqlx::query("UPDATE lab_experiments SET status = 'running', finished_at = NULL WHERE id = ?").bind(&d.item.id).execute(&pool).await.unwrap();
    assert_eq!(worker.finish_complete().await.unwrap(), 1);
    let done = detail(&pool, "admin", &d.item.id).await.unwrap();
    assert_eq!((done.item.status.as_str(), done.item.progress.done), ("done", 4));
    assert!(done.item.label.finished_at.is_some());
    assert_eq!(worker.finish_complete().await.unwrap(), 0);
}

#[tokio::test]
async fn the_run_list_comes_a_page_at_a_time() {
    let pool = fixture().await;
    let sim = FakeSim::new();
    let admin = user("admin", true);
    let mut ids = Vec::new();
    for _ in 0..3 {
        ids.push(create(&pool, &admin, swap_req(4), sim.as_ref()).await.unwrap().item.id);
    }
    ids.reverse(); // newest first
    let page = |limit: i64, before: Option<&str>| ListPage { limit: Some(limit), before: before.map(str::to_string), active: false };
    let first: Vec<String> = list(&pool, "admin", &page(2, None)).await.unwrap().into_iter().map(|e| e.id).collect();
    assert_eq!(first, ids[..2]);
    let next: Vec<String> = list(&pool, "admin", &page(2, Some(&first[1]))).await.unwrap().into_iter().map(|e| e.id).collect();
    assert_eq!(next, ids[2..]);
    assert!(list(&pool, "admin", &page(2, Some(&ids[2]))).await.unwrap().is_empty());
    // Runs still to play, however old, for "Running now".
    sqlx::query("UPDATE lab_experiments SET status = 'done' WHERE id IN (?, ?)").bind(&ids[0]).bind(&ids[1]).execute(&pool).await.unwrap();
    let active: Vec<String> = list(&pool, "admin", &ListPage { limit: Some(1), active: true, ..ListPage::default() }).await.unwrap().into_iter().map(|e| e.id).collect();
    assert_eq!(active, ids[2..]);
    // Someone else's run, or one that's gone, starts from the newest again.
    assert_eq!(list(&pool, "admin", &page(2, Some("not-a-run"))).await.unwrap().len(), 2);
    assert_eq!(list(&pool, "admin", &ListPage::default()).await.unwrap().len(), 3);
}

#[tokio::test]
async fn a_runs_lists_are_frozen_with_the_combos_known_in_them() {
    let pool = fixture().await;
    // Yama's copy of Spellbook's combos (combos.rs): Sol Ring with Forest (every precon has
    // both), Sol Ring with Elvish Mystic (only the changed list), and one with a card no list has.
    for sql in [
        "INSERT INTO import_runs (id, kind, started_at, finished_at) VALUES ('r', 'spellbook_variants', '2026-11-13T00:00:00Z', '2026-11-13T00:01:00Z')",
        "INSERT INTO spellbook_cards (n, oracle_id) VALUES (1, 'o-sol-ring'), (2, 'o-elvish-mystic'), (3, 'o-black-lotus'), (4, 'o-forest')",
        "INSERT INTO spellbook_combos (n, id, cards, popularity, run) VALUES (1, 'ring-mystic', 2, 9, 'r'), (2, 'ring-lotus', 2, 99, 'r'), (3, 'ring-forest', 2, 5, 'r')",
        "INSERT INTO spellbook_combo_cards (card, combo) VALUES (1, 1), (2, 1), (1, 2), (3, 2), (1, 3), (4, 3)",
    ] {
        sqlx::query(sql).execute(&pool).await.unwrap();
    }
    let sim = FakeSim::new();
    let d = create(&pool, &user("bryan", false), swap_req(100), sim.as_ref()).await.unwrap();
    let spec: String = sqlx::query_scalar("SELECT spec FROM lab_experiments WHERE id = ?").bind(&d.item.id).fetch_one(&pool).await.unwrap();
    let spec: ExperimentSpec = serde_json::from_str(&spec).unwrap();
    let combo = |id: &str, cards: &[&str]| LabCombo { id: id.into(), cards: cards.iter().map(|c| c.to_string()).collect() };
    let ring_forest = combo("ring-forest", &["Forest", "Sol Ring"]);
    assert_eq!(spec.base.combos, [ring_forest.clone()]);
    // The more popular first, each card as the list names it.
    assert_eq!(spec.variant.as_ref().unwrap().combos, [combo("ring-mystic", &["Elvish Mystic", "Sol Ring"]), ring_forest.clone()]);
    assert_eq!(spec.opponents.len(), 3);
    assert!(spec.opponents.iter().all(|o| o.list.combos == [ring_forest.clone()]));
}
