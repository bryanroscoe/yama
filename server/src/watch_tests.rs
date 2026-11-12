//! Watched games: the play loop on a scripted game (no engine needed), the hub's caps and
//! privacy, and the routes.

use super::*;
use crate::testutil;
use axum::http::{Method, StatusCode};
use serde_json::json;
use std::collections::BTreeMap;

/// A scripted game: every action counts; every `every`th one changes what a viewer sees (a
/// life total), every `per_turn`th starts a new turn (0: never), and after `total` it's over.
struct Script {
    done: usize,
    total: usize,
    every: usize,
    per_turn: usize,
    /// Fail at this action.
    fail_at: Option<usize>,
}

impl Script {
    fn new(total: usize, every: usize, per_turn: usize) -> Self {
        Self { done: 0, total, every, per_turn, fail_at: None }
    }
}

fn board(turn: u32, life: i32, over: bool, reveal: bool) -> View {
    let player = |seat: u8, life: i32| PlayerView {
        seat,
        life,
        poison: 0,
        hand: 7,
        library: 90,
        graveyard: vec![],
        eliminated: false,
        conceded: false,
        commander_damage: BTreeMap::new(),
        companion: None,
    };
    let card = CardView {
        id: 1,
        name: "Grizzly Bears".into(),
        controller: 0,
        owner: 0,
        tapped: false,
        power: Some(2),
        toughness: Some(2),
        loyalty: None,
        damage: 0,
        counters: BTreeMap::new(),
        types: vec!["Creature".into()],
        attached_to: None,
        attacking: false,
        attacks: None,
        blocking: false,
        commander: false,
        tax: 0,
        sick: false,
        ..Default::default()
    };
    View {
        revision: 0,
        turn,
        active: 0,
        phase: "PreCombatMain".into(),
        waiting_on: vec![0],
        waiting: "Priority".into(),
        players: vec![player(0, life), player(1, 40)],
        battlefield: vec![],
        stack: vec![],
        command_zone: vec![],
        exile: vec![],
        hand: vec![],
        hands: if reveal { BTreeMap::from([(0, vec![card.clone()]), (1, vec![card])]) } else { BTreeMap::new() },
        decision: None,
        log: vec![],
        over,
        abandoned: false,
        can_go_back: false,
        rewind_steps: 0,
        rewind_checkpoint: None,
        winner: over.then_some(0),
        turns: None,
        resolve_all: None,
        together: None,
        events: vec![],
        outs: vec![],
        stats: None,
    }
}

impl Driver for Script {
    fn advance(&mut self) -> Result<Advance, String> {
        if self.fail_at == Some(self.done) {
            return Err("boom".into());
        }
        self.done += 1;
        Ok(Advance::Acted)
    }
    fn view(&self, reveal: bool) -> View {
        board(self.turn(), 40 - (self.done / self.every) as i32, self.over(), reveal)
    }
    fn turn(&self) -> u32 {
        if self.per_turn == 0 { 1 } else { 1 + (self.done / self.per_turn) as u32 }
    }
    fn over(&self) -> bool {
        self.done >= self.total
    }
}

fn quick() -> Timing {
    Timing {
        idle_pause: Duration::from_secs(60),
        idle_stop: Duration::from_secs(120),
        keep_finished: Duration::from_secs(60),
        delays: [Duration::from_millis(5), Duration::from_millis(2), Duration::from_millis(1)],
        slice: Duration::from_millis(5),
        step_actions: 400,
        max_turns: 60,
        max_actions: 60_000,
        turn_action_cap: 3_000,
        max_cpu_secs: 900.0,
    }
}

fn fresh(speed: Speed) -> Status {
    Status { playing: true, speed, reveal: false, idle: false, actions: 0, stopped: None, finished: false }
}

/// Run a script on this thread with someone watching; returns the last frame.
fn play_out(mut d: Script, t: &Timing, status: Status, cmds: &[WatchCmd]) -> Arc<Frame> {
    let (tx, rx) = std::sync::mpsc::channel();
    for c in cmds {
        tx.send(*c).unwrap();
    }
    let (out, frames) = watch::channel(Arc::new(Frame { view: d.view(false), status: status.clone() }));
    let presence = Arc::new(Presence::new());
    let _viewer = Viewer::join(&presence);
    run(&mut d, &rx, &out, &presence, t, status);
    frames.borrow().clone()
}

#[test]
fn a_game_plays_to_the_end_at_every_speed() {
    for speed in [Speed::End, Speed::X4, Speed::X1] {
        let f = play_out(Script::new(300, 10, 50), &quick(), fresh(speed), &[]);
        assert!(f.status.finished, "{speed:?}");
        assert_eq!(f.status.stopped, None);
        assert_eq!(f.status.actions, 300);
        assert!(f.view.over);
        assert_eq!(f.view.winner, Some(0));
    }
}

#[test]
fn the_loop_guard_ends_a_turn_that_never_ends() {
    // No turn ever ends: the per-turn guard stops it long before max_actions.
    let t = Timing { turn_action_cap: 500, ..quick() };
    let f = play_out(Script::new(1_000_000, 10, 0), &t, fresh(Speed::End), &[]);
    assert!(f.status.finished);
    assert_eq!(f.status.actions, 500);
    assert!(f.status.stopped.as_deref().unwrap().contains("going round in circles"), "{:?}", f.status.stopped);
}

#[test]
fn turn_and_action_caps_and_engine_errors_end_the_game() {
    let t = Timing { max_turns: 5, ..quick() };
    let f = play_out(Script::new(1_000_000, 10, 20), &t, fresh(Speed::End), &[]);
    assert_eq!(f.status.stopped.as_deref(), Some("Stopped at turn 5, the limit for a watched game"));

    let t = Timing { max_actions: 123, ..quick() };
    let f = play_out(Script::new(1_000_000, 10, 20), &t, fresh(Speed::End), &[]);
    assert_eq!(f.status.actions, 123);
    assert!(f.status.stopped.as_deref().unwrap().contains("123 actions"));

    let mut s = Script::new(1_000, 10, 20);
    s.fail_at = Some(42);
    let f = play_out(s, &quick(), fresh(Speed::End), &[]);
    assert_eq!(f.status.actions, 42);
    assert!(f.status.stopped.as_deref().unwrap().contains("boom"));
}

#[test]
fn a_step_moves_to_the_next_visible_change_and_pauses() {
    // Paused, then one step: ten actions (the life total changes every 10th), then it holds.
    let (tx, rx) = std::sync::mpsc::channel();
    let mut d = Script::new(1_000, 10, 50);
    let (out, frames) = watch::channel(Arc::new(Frame { view: d.view(false), status: fresh(Speed::X1) }));
    let presence = Arc::new(Presence::new());
    let _viewer = Viewer::join(&presence);
    tx.send(WatchCmd::Pause).unwrap();
    tx.send(WatchCmd::Step).unwrap();
    let t = quick();
    let handle = std::thread::spawn(move || {
        run(&mut d, &rx, &out, &presence, &t, fresh(Speed::X1));
    });
    std::thread::sleep(Duration::from_millis(300));
    let f = frames.borrow().clone();
    assert_eq!(f.status.actions, 10, "one step is one visible change");
    assert!(!f.status.playing && !f.status.finished);
    assert_eq!(f.view.players[0].life, 39);
    // Still holding a moment later.
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(frames.borrow().status.actions, 10);
    // Hands come up face up on request, then it plays on and stops when told.
    tx.send(WatchCmd::Reveal(true)).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(frames.borrow().view.hands.len(), 2);
    assert!(frames.borrow().status.reveal);
    tx.send(WatchCmd::Play).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert!(frames.borrow().status.actions > 10);
    tx.send(WatchCmd::Stop).unwrap();
    handle.join().unwrap();
    let f = frames.borrow().clone();
    assert!(f.status.finished);
    assert_eq!(f.status.stopped.as_deref(), Some("Stopped by you"));
}

#[test]
fn nobody_watching_pauses_the_game_then_ends_it() {
    let t = Timing { idle_pause: Duration::from_millis(50), idle_stop: Duration::from_millis(400), ..quick() };
    let (_tx, rx) = std::sync::mpsc::channel();
    let mut d = Script::new(10_000_000, 10, 50);
    let (out, frames) = watch::channel(Arc::new(Frame { view: d.view(false), status: fresh(Speed::X1) }));
    let presence = Arc::new(Presence::new());
    let p = presence.clone();
    let handle = std::thread::spawn(move || run(&mut d, &rx, &out, &p, &t, fresh(Speed::X1)));
    std::thread::sleep(Duration::from_millis(200));
    let paused = frames.borrow().status.clone();
    assert!(paused.idle && !paused.finished, "{paused:?}");
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(frames.borrow().status.actions, paused.actions, "an idle game doesn't move");
    // A viewer arriving wakes it up.
    let v = Viewer::join(&presence);
    std::thread::sleep(Duration::from_millis(100));
    assert!(!frames.borrow().status.idle);
    assert!(frames.borrow().status.actions > paused.actions);
    drop(v);
    handle.join().unwrap();
    let f = frames.borrow().clone();
    assert!(f.status.finished);
    assert!(f.status.stopped.as_deref().unwrap().contains("nobody watching"));
}

// ── the hub ────────────────────────────────────────────────────────────────

fn user(id: &str, limited: bool, admin: bool) -> User {
    User { id: id.into(), email: format!("{id}@example.com"), display_name: id.into(), is_admin: admin, limited, power: true, guest: false }
}

fn request() -> CreateRequest {
    serde_json::from_value(json!({
        "seats": [
            {"deck": {"kind": "precon", "id": "a"}, "pilot": {"kind": "ai", "difficulty": "Easy"}},
            {"deck": {"kind": "precon", "id": "b"}, "pilot": {"kind": "ai"}}
        ],
        "speed": "1x"
    }))
    .unwrap()
}

/// A game that won't finish on its own (paused at once, nobody needs to watch).
fn park(hub: &WatchHub, u: &User) -> Arc<WatchGame> {
    let g = hub.spawn(u, vec![], HashMap::new(), request(), Box::new(Script::new(10_000_000, 10, 50))).unwrap();
    g.send(WatchCmd::Pause);
    g
}

/// An account that isn't a power user: every signed-in account may watch (12 Nov 2026).
fn plain(id: &str) -> User {
    User { power: false, ..user(id, true, false) }
}

fn wait_finished(g: &WatchGame) {
    for _ in 0..200 {
        if g.presence.finished() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("game didn't finish");
}

#[test]
fn caps_on_unfinished_games_per_account_and_for_everyone() {
    let hub = WatchHub::with_timing(quick());
    let invited = user("ann", false, false);
    let stranger = user("sam", true, false);
    let admin = user("bryan", false, true);
    let mut games = vec![];
    for _ in 0..MAX_WATCH_GAMES {
        hub.check_caps(&invited).unwrap();
        games.push(park(&hub, &invited));
    }
    assert!(matches!(hub.check_caps(&invited), Err(AppError::Conflict(_))));
    // A power user with the standard allowance gets one.
    hub.check_caps(&stranger).unwrap();
    games.push(park(&hub, &stranger));
    let Err(AppError::Conflict(msg)) = hub.check_caps(&stranger) else { panic!("second game allowed") };
    assert!(msg.contains("already have a game") && msg.contains("one at a time"), "{msg}");
    // Admins aren't capped, and their games don't count against anyone.
    for _ in 0..MAX_WATCH_GAMES_ALL {
        hub.check_caps(&admin).unwrap();
        games.push(park(&hub, &admin));
    }
    // Stopping a game frees its place once its thread ends.
    games[0].send(WatchCmd::Stop);
    wait_finished(&games[0]);
    hub.check_caps(&invited).unwrap();
    // Everyone together: fill up to the global cap with other accounts.
    for i in 0..(MAX_WATCH_GAMES_ALL - 3) {
        let u = user(&format!("u{i}"), false, false);
        hub.check_caps(&u).unwrap();
        games.push(park(&hub, &u));
    }
    let Err(AppError::Conflict(msg)) = hub.check_caps(&user("late", false, false)) else { panic!("global cap") };
    assert!(msg.contains("busy"), "{msg}");
    for g in games {
        g.send(WatchCmd::Stop);
    }
}

#[test]
fn accounts_with_the_small_allowance_share_a_smaller_pool() {
    let hub = WatchHub::with_timing(quick());
    let mut games = vec![];
    for i in 0..OPEN_MAX_WATCH_GAMES_ALL {
        let u = user(&format!("s{i}"), true, false);
        hub.check_caps(&u).unwrap();
        games.push(park(&hub, &u));
    }
    assert!(hub.check_caps(&user("s-late", true, false)).is_err());
    hub.check_caps(&user("invited", false, false)).unwrap();
    for g in games {
        g.send(WatchCmd::Stop);
    }
}

#[test]
fn every_account_may_watch_one_game_at_a_time_and_a_number_a_day() {
    let hub = WatchHub::with_timing(quick());
    let pat = plain("pat");
    // Invited or not, an account that isn't a power user has the small allowance.
    for u in [&pat, &User { limited: false, ..plain("friend") }] {
        assert_eq!((small_allowance(u), at_a_time(u), per_day(u)), (true, Some(1), Some(WATCH_GAMES_PER_DAY)));
    }
    assert_eq!(hub.allowance(&pat), Allowance { at_a_time: Some(1), per_day: Some(WATCH_GAMES_PER_DAY), used_today: Some(0) });
    // Power users keep theirs, with no daily count; admins have no cap at all.
    assert_eq!(hub.allowance(&user("ann", false, false)), Allowance { at_a_time: Some(MAX_WATCH_GAMES), per_day: None, used_today: None });
    assert_eq!(hub.allowance(&user("sam", true, false)), Allowance { at_a_time: Some(1), per_day: None, used_today: None });
    assert_eq!(hub.allowance(&user("bryan", false, true)), Allowance { at_a_time: None, per_day: None, used_today: None });

    // One at a time: a second game is refused, and the refusal uses up none of the day.
    let first = park(&hub, &pat);
    let Err(AppError::Conflict(msg)) = hub.spawn(&pat, vec![], HashMap::new(), request(), Box::new(Script::new(10, 1, 5))) else { panic!("a second game at once") };
    assert!(msg.contains("one at a time"), "{msg}");
    assert_eq!(hub.allowance(&pat).used_today, Some(1));
    first.send(WatchCmd::Stop);
    wait_finished(&first);
    // The rest of the day's games, one after another.
    for _ in 1..WATCH_GAMES_PER_DAY {
        hub.check_caps(&pat).unwrap();
        let g = park(&hub, &pat);
        g.send(WatchCmd::Stop);
        wait_finished(&g);
    }
    assert_eq!(hub.allowance(&pat).used_today, Some(WATCH_GAMES_PER_DAY));
    // The next one is refused before anything is loaded (check_caps) and where it counts (spawn),
    // and the refusal says the limit.
    for refused in [hub.check_caps(&pat), hub.spawn(&pat, vec![], HashMap::new(), request(), Box::new(Script::new(10, 1, 5))).map(|_| ())] {
        let Err(AppError::TooManyRequests { message, retry_after }) = refused else { panic!("past the day's count") };
        assert_eq!(message, format!("You can start {WATCH_GAMES_PER_DAY} watched games a day, and you've started {WATCH_GAMES_PER_DAY} in the last 24 hours. Try again in 24 hours."));
        assert!(retry_after > 23 * 3600, "{retry_after}");
    }
    assert_eq!(hub.mine("pat").iter().filter(|g| g.unfinished()).count(), 0, "a refused game leaves no thread");
    // Another account's day is its own, and power users and admins aren't counted.
    park(&hub, &plain("kim")).send(WatchCmd::Stop);
    let ann = user("ann", false, false);
    for _ in 0..WATCH_GAMES_PER_DAY + 2 {
        let g = park(&hub, &ann);
        g.send(WatchCmd::Stop);
        wait_finished(&g);
    }
}

/// Requests arriving together: the caps and the day's count are checked where the game is kept,
/// under one lock, so only as many as fit get a thread.
#[test]
fn games_started_together_cant_pass_the_caps() {
    // Slow moves, so the one game that starts is still playing however late a contender asks.
    let hub = WatchHub::with_timing(Timing { delays: [Duration::from_secs(1); 3], ..quick() });
    let pat = plain("pat");
    let start = std::sync::Barrier::new(16);
    let started: Vec<Arc<WatchGame>> = std::thread::scope(|s| {
        let threads: Vec<_> = (0..16)
            .map(|_| {
                s.spawn(|| {
                    start.wait();
                    hub.spawn(&pat, vec![], HashMap::new(), request(), Box::new(Script::new(10_000_000, 10, 50))).ok()
                })
            })
            .collect();
        threads.into_iter().filter_map(|t| t.join().unwrap()).collect()
    });
    assert_eq!(started.len(), 1, "one game at a time, however many ask at once");
    assert_eq!(hub.allowance(&pat).used_today, Some(1), "only the game that started counts");
    assert_eq!(hub.mine("pat").len(), 1);
    for g in started {
        g.send(WatchCmd::Stop);
    }
}

#[test]
fn only_the_owner_sees_a_game_and_finished_games_are_forgotten() {
    let hub = WatchHub::with_timing(Timing { keep_finished: Duration::from_millis(50), ..quick() });
    let ann = user("ann", false, false);
    let g = park(&hub, &ann);
    assert!(hub.get(&g.id, "ann").is_ok());
    assert!(matches!(hub.get(&g.id, "sam"), Err(AppError::NotFound(_))));
    assert_eq!(hub.mine("ann").len(), 1);
    assert!(hub.mine("sam").is_empty());
    g.send(WatchCmd::Stop);
    wait_finished(&g);
    // Kept for a while after it ends, then swept.
    assert!(hub.get(&g.id, "ann").is_ok());
    std::thread::sleep(Duration::from_millis(80));
    assert!(hub.get(&g.id, "ann").is_err());
}

#[test]
fn a_panicking_game_ends_with_a_message() {
    struct Panics;
    impl Driver for Panics {
        fn advance(&mut self) -> Result<Advance, String> {
            panic!("engine bug");
        }
        fn view(&self, reveal: bool) -> View {
            board(1, 40, false, reveal)
        }
        fn turn(&self) -> u32 {
            1
        }
        fn over(&self) -> bool {
            false
        }
    }
    let hub = WatchHub::with_timing(quick());
    let g = hub.spawn(&user("ann", false, false), vec![], HashMap::new(), request(), Box::new(Panics)).unwrap();
    wait_finished(&g);
    std::thread::sleep(Duration::from_millis(20));
    let f = g.frames.borrow().clone();
    assert!(f.status.finished);
    assert_eq!(f.status.stopped.as_deref(), Some("Stopped: the rules engine hit an error"));
}

// ── routes ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn routes_check_seats_decks_and_owners() {
    let st = testutil::state().await;
    let app = crate::routes::app(st.clone());
    let (ann, ann_token) = testutil::power_user(&st.pool, "ann@example.com").await;
    let (_sam, sam_token) = testutil::power_user(&st.pool, "sam@example.com").await;
    let (kim, kim_token) = testutil::user(&st.pool, "kim@example.com").await;
    let (deck, _) = testutil::deck(&st.pool, &ann, "Ann's deck").await;
    let seat = |deck: &str| json!({"deck": {"kind": "deck", "id": deck}, "pilot": {"kind": "ai", "difficulty": "Hard"}});

    // Not signed in.
    let (code, _) = testutil::send(&app, Method::GET, "/api/watch", None, None).await;
    assert_eq!(code, StatusCode::UNAUTHORIZED);
    // Every signed-in account may watch (12 Nov 2026): an account that isn't a power user gets as
    // far as a power user does here (no engine on this server), and hears its allowance.
    let (kims, _) = testutil::deck(&st.pool, &kim, "Kim's deck").await;
    let (code, body) = testutil::send(&app, Method::POST, "/api/watch", Some(&kim_token), Some(json!({"seats": [seat(&kims), seat(&kims)]}))).await;
    assert_eq!(code, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.to_string().contains("online play is off"), "{body}");
    let (code, body) = testutil::send(&app, Method::GET, "/api/watch/allowance", Some(&kim_token), None).await;
    assert_eq!((code, &body), (StatusCode::OK, &json!({"at_a_time": 1, "per_day": WATCH_GAMES_PER_DAY, "used_today": 0})));
    let (_, body) = testutil::send(&app, Method::GET, "/api/watch/allowance", Some(&ann_token), None).await;
    assert_eq!(body, json!({"at_a_time": MAX_WATCH_GAMES, "per_day": null, "used_today": null}));
    let (code, _) = testutil::send(&app, Method::GET, "/api/watch/allowance", None, None).await;
    assert_eq!(code, StatusCode::UNAUTHORIZED);
    // Seat counts, levels and LLM seats.
    let (code, body) = testutil::send(&app, Method::POST, "/api/watch", Some(&ann_token), Some(json!({"seats": [seat(&deck)]}))).await;
    assert_eq!(code, StatusCode::BAD_REQUEST, "{body}");
    let five = json!({"seats": [seat(&deck), seat(&deck), seat(&deck), seat(&deck), seat(&deck)]});
    let (code, _) = testutil::send(&app, Method::POST, "/api/watch", Some(&ann_token), Some(five)).await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    let llm = json!({"seats": [seat(&deck), {"deck": {"kind": "deck", "id": deck}, "pilot": {"kind": "llm"}}]});
    let (code, body) = testutil::send(&app, Method::POST, "/api/watch", Some(&ann_token), Some(llm)).await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(body.to_string().contains("LLM seats"), "{body}");
    let first = json!({"seats": [seat(&deck), seat(&deck)], "first": 2});
    let (code, _) = testutil::send(&app, Method::POST, "/api/watch", Some(&ann_token), Some(first)).await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    // Someone else's deck is "not found", before anything else happens.
    let (code, _) = testutil::send(&app, Method::POST, "/api/watch", Some(&sam_token), Some(json!({"seats": [seat(&deck), seat(&deck)]}))).await;
    assert_eq!(code, StatusCode::NOT_FOUND);
    let precon = json!({"seats": [seat(&deck), {"deck": {"kind": "precon", "id": "no-such-precon"}, "pilot": {"kind": "ai"}}]});
    let (code, _) = testutil::send(&app, Method::POST, "/api/watch", Some(&ann_token), Some(precon)).await;
    assert_eq!(code, StatusCode::NOT_FOUND);
    // Your own decks, but no engine on this server: online play is off.
    let (code, body) = testutil::send(&app, Method::POST, "/api/watch", Some(&ann_token), Some(json!({"seats": [seat(&deck), seat(&deck)]}))).await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(body.to_string().contains("online play is off"), "{body}");

    // A running game: its owner sees it, nobody else does.
    let owner = User { id: ann.clone(), email: "ann@example.com".into(), display_name: "ann".into(), is_admin: false, limited: false, power: true, guest: false };
    let g = park(&st.watch, &owner);
    let (code, body) = testutil::send(&app, Method::GET, &format!("/api/watch/{}", g.id), Some(&ann_token), None).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["status"]["finished"], false);
    let (code, list) = testutil::send(&app, Method::GET, "/api/watch", Some(&ann_token), None).await;
    assert_eq!((code, list.as_array().map(Vec::len)), (StatusCode::OK, Some(1)));
    let (_, list) = testutil::send(&app, Method::GET, "/api/watch", Some(&sam_token), None).await;
    assert_eq!(list.as_array().map(Vec::len), Some(0));
    for (method, path) in [
        (Method::GET, format!("/api/watch/{}", g.id)),
        (Method::POST, format!("/api/watch/{}/stop", g.id)),
        (Method::POST, format!("/api/watch/{}/again", g.id)),
        (Method::DELETE, format!("/api/watch/{}", g.id)),
    ] {
        let (code, _) = testutil::send(&app, method.clone(), &path, Some(&sam_token), None).await;
        assert_eq!(code, StatusCode::NOT_FOUND, "{method} {path}");
    }
    // The owner stops it, then removes it.
    let (code, _) = testutil::send(&app, Method::POST, &format!("/api/watch/{}/stop", g.id), Some(&ann_token), None).await;
    assert_eq!(code, StatusCode::OK);
    wait_finished(&g);
    let (_, body) = testutil::send(&app, Method::GET, &format!("/api/watch/{}", g.id), Some(&ann_token), None).await;
    assert_eq!(body["status"]["finished"], true);
    assert_eq!(body["status"]["stopped"], "Stopped by you");
    let (code, _) = testutil::send(&app, Method::DELETE, &format!("/api/watch/{}", g.id), Some(&ann_token), None).await;
    assert_eq!(code, StatusCode::OK);
    let (code, _) = testutil::send(&app, Method::GET, &format!("/api/watch/{}", g.id), Some(&ann_token), None).await;
    assert_eq!(code, StatusCode::NOT_FOUND);
}

#[test]
fn signatures_ignore_whose_priority_it_is_but_not_the_board() {
    let a = board(3, 40, false, false);
    let mut b = a.clone();
    b.revision = 99;
    b.waiting_on = vec![1];
    b.phase = "End".into();
    b.active = 1;
    assert_eq!(signature(&a), signature(&b));
    b.players[1].life = 39;
    assert_ne!(signature(&a), signature(&b));
    let mut c = a.clone();
    c.turn = 4;
    assert_ne!(signature(&a), signature(&c));
}
