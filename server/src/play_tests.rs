//! The `act` message end to end on a live game thread: the whitelist at the socket, answers
//! checked against the seat's own decision, refusals that leave the game as it was, and card
//! details for the deciding seat only. The engine runs on the play crate's small card fixture.

use super::*;
use std::time::Duration;
use yama_play::OptionKind;

fn engine() -> Engine {
    Engine::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../play/tests/fixtures/act-cards.json")).unwrap()
}

fn deck(cards: &[(&str, usize)]) -> SeatDeck {
    SeatDeck { commander: vec!["Combat Celebrant".into()], main: cards.iter().flat_map(|(name, n)| vec![name.to_string(); *n]).collect() }
}

fn seat(n: u8, name: &str) -> SeatCfg {
    SeatCfg {
        seat: n,
        kind: "human".into(),
        user_id: Some(format!("user-{n}")),
        name: name.into(),
        deck_id: None,
        deck_version_id: None,
        deck_name: None,
        color_identity: String::new(),
        commander: None,
        difficulty: None,
        bracket: None,
    }
}

/// The board one seat was last sent, once the game thread has published it.
async fn board(live: &LiveGame, you: u8) -> View {
    for _ in 0..200 {
        if let Some(v) = live.views.borrow().views.get(&Some(you)) {
            return v.clone();
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no board for seat {you}");
}

/// The board after the game thread has handled everything sent so far (a command it answers).
async fn settled(live: &LiveGame, you: u8, after: u64) -> View {
    for _ in 0..200 {
        let v = board(live, you).await;
        if v.revision > after {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the game didn't move on");
}

async fn send(live: &LiveGame, make: impl FnOnce(oneshot::Sender<Result<(), String>>) -> Cmd) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    live.cmds.send(make(tx)).unwrap();
    rx.await.unwrap()
}

async fn choose(live: &LiveGame, you: u8, kind: OptionKind) {
    let d = board(live, you).await.decision.expect("a decision");
    let index = d.options.iter().find(|o| o.kind == kind).unwrap_or_else(|| panic!("no {kind:?} option")).index;
    let before = board(live, you).await.revision;
    send(live, |reply| Cmd::Choose { seat: you, revision: d.revision, index, reply }).await.unwrap();
    settled(live, you, before).await;
}

#[test]
fn only_whitelisted_answers_parse() {
    let ok = |s: &str| serde_json::from_str::<ClientMessage>(s).is_ok();
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"select_cards","cards":[12,13]}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"order_triggers","order":[1,0]}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_target","target":{"kind":"player","seat":1}}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"distribute_among","distribution":[[{"kind":"object","id":7},2]]}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"cancel_cast"}}"#));
    // Answers the engine remembers, and soulbond.
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"decide_optional_effect_and_remember","accept":true}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_replacement_and_remember","choice":{"type":"order","order":[1,0]}}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_replacement_and_remember","choice":{"type":"optional","index":0}}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_pair","partner":12}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_pair","partner":null}}"#));
    // A seat's own settings and Resolve all, in Yama's own shapes (play/src/turns.rs).
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"set_may_trigger_auto_choice","change":{"op":"clear_all"}}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"set_priority_yield","change":{"op":"add","source":44,"every":false}}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"set_replacement_auto_choice","id":null}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"reorder_hand","order":[3,1,2]}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"resolve_all"}}"#));
    // Not the engine's own forms of them, nor other preference actions it has.
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"set_may_trigger_auto_choice","op":{}}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"set_priority_yield","change":{"op":"add_everything"}}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"begin_resolve_all","max_resolutions":0,"scope":{"type":"Shared"}}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"set_auto_pass","mode":{"type":"UntilStackEmpty"}}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"concede"}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_replacement_and_remember","choice":{"type":"forget"}}}"#));
    // Paying (play/src/pay.rs): a cast with the seat's setting, taps, untaps, the Treasure
    // prompt's "Keep it", colours, Phyrexian mana and extra costs.
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"cast_spell","object":40,"payment":"manual"}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"tap_mana","source":41,"choice":"tap:0:W"}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"tap_mana","source":41}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"untap_mana","source":41}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"keep_mana"}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_mana_color","mana":["R"]}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"pay_phyrexian","life":[true,false]}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"decide_optional_cost","pay":true}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_cost_branch","index":1}}"#));
    // Not a payment mode the setting doesn't have, nor the engine's raw mana actions.
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"cast_spell","object":40,"payment":"free"}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"tap_land_for_mana","selection":{}}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"submit_phyrexian_choices","choices":[]}}"#));
    // The auto-tap preview, and "Tap mana for me" with the other settings (older boards leave it out).
    assert!(ok(r#"{"type":"preview","revision":3,"object":40}"#));
    assert!(ok(r#"{"type":"prefs","stops":null,"full_control":false,"tap_mana":"manual"}"#));
    assert!(ok(r#"{"type":"prefs","stops":null,"full_control":false}"#));
    assert!(!ok(r#"{"type":"prefs","stops":null,"full_control":false,"tap_mana":"sometimes"}"#));
    // Turn controls.
    assert!(ok(r#"{"type":"pass","revision":3,"mode":"mine"}"#));
    assert!(ok(r#"{"type":"pass","revision":3,"mode":null}"#));
    assert!(!ok(r#"{"type":"pass","revision":3,"mode":"forever"}"#));
    assert!(ok(r#"{"type":"hold","on":true}"#));
    assert!(ok(r#"{"type":"prefs","stops":{"own":["Upkeep"],"others":[]},"full_control":false}"#));
    assert!(ok(r#"{"type":"prefs","stops":null,"full_control":true}"#));
    // Nothing outside the whitelist can be spelled: not a debug action, not a pass, not an
    // engine action in its own serialized form.
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"debug","action":{}}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"pass_priority"}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"type":"PassPriority"}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"select_cards"}}"#));
}

#[tokio::test(flavor = "multi_thread")]
async fn act_is_checked_against_the_seats_own_decision() {
    let pool = crate::db::test_pool().await;
    let hub = Arc::new(PlayHub { engine: Mutex::new(EngineState::Ready(Arc::new(engine()))), live: Mutex::new(HashMap::new()) });
    // Two people. Seat 0's cards (Island, Opt, Preordain) appear nowhere in seat 1's deck.
    let mine = deck(&[("Island", 50), ("Opt", 25), ("Preordain", 24)]);
    let theirs = deck(&[("Mountain", 60), ("Blaze", 39)]);
    let m = engine().new_match_first(5, vec![mine, theirs], &[], Some(0)).unwrap();
    hub.spawn_game("game-act-1".into(), m, vec![seat(0, "Ana"), seat(1, "Ben")], HashMap::new(), pool.clone());
    let live = hub.live("game-act-1").unwrap();

    // Seat 0 mulligans twice (the first is free) and keeps: one card goes to the bottom.
    choose(&live, 0, OptionKind::Mulligan).await;
    choose(&live, 0, OptionKind::Mulligan).await;
    choose(&live, 0, OptionKind::Keep).await;
    let me = board(&live, 0).await;
    let d = me.decision.clone().expect("seat 0 owes a bottom card");
    let p = d.pending.clone().expect("the bottom step is a pick");
    let json = serde_json::to_value(&p).unwrap();
    assert_eq!((json["kind"].as_str(), json["purpose"].as_str(), json["min"].as_u64(), json["max"].as_u64()), (Some("pick"), Some("bottom"), Some(1), Some(1)));
    assert_eq!(json["upTo"], false, "camelCase on the wire");
    assert_eq!(json["destination"], "bottom");
    let hand: Vec<u64> = me.hand.iter().map(|c| c.id).collect();
    assert_eq!(p.options.len(), hand.len());

    // The wrong seat: seat 1 keeps, then has no decision at all.
    choose(&live, 1, OptionKind::Keep).await;
    let them = board(&live, 1).await;
    assert!(them.decision.is_none());
    let err = send(&live, |reply| Cmd::Act { seat: 1, revision: them.revision, action: Act::SelectCards { cards: vec![hand[0]] }, reply }).await;
    assert_eq!(err, Err("it isn't your decision".into()));

    // Rejected answers say why and leave the game as it was.
    let before = board(&live, 0).await;
    let d = before.decision.clone().unwrap();
    let two = send(&live, |reply| Cmd::Act { seat: 0, revision: d.revision, action: Act::SelectCards { cards: hand[..2].to_vec() }, reply }).await;
    assert_eq!(two, Err("Choose exactly 1 card.".into()));
    let theirs_card = them.hand[0].id;
    let wrong = send(&live, |reply| Cmd::Act { seat: 0, revision: d.revision, action: Act::SelectCards { cards: vec![theirs_card] }, reply }).await;
    assert_eq!(wrong, Err("That card isn't one of the choices.".into()));
    let other_kind = send(&live, |reply| Cmd::Act { seat: 0, revision: d.revision, action: Act::ChooseX { value: 2 }, reply }).await;
    assert_eq!(other_kind, Err("That answer doesn't fit this decision.".into()));
    let after = board(&live, 0).await;
    assert_eq!(after.revision, before.revision);
    assert_eq!(after.hand.len(), before.hand.len());

    // Hidden information: seat 1's board, and the card details it gets, name none of seat 0's cards.
    let mine_names: Vec<String> = p.card_names();
    assert!(mine_names.iter().all(|n| ["Island", "Opt", "Preordain"].contains(&n.as_str())), "{mine_names:?}");
    let their_names = view_names(&board(&live, 1).await);
    assert!(!their_names.iter().any(|n| ["Island", "Opt", "Preordain"].contains(&n.as_str())), "{their_names:?}");
    assert!(serde_json::to_string(&board(&live, 1).await).unwrap().find("\"pending\"").is_none());
    assert!(serde_json::to_string(&board(&live, 1).await.decision).unwrap() == "null");
    // Seat 0's own card details cover its decision.
    let my_names = view_names(&after);
    assert!(mine_names.iter().all(|n| my_names.contains(n)));

    // The right answer is taken and the game moves on.
    let ok = send(&live, |reply| Cmd::Act { seat: 0, revision: d.revision, action: Act::SelectCards { cards: vec![hand[0]] }, reply }).await;
    assert_eq!(ok, Ok(()));
    let moved = settled(&live, 0, before.revision).await;
    assert!(moved.decision.as_ref().is_none_or(|d| d.pending.as_ref().is_none_or(|p| p.purpose != "bottom")));
    let _ = live.cmds.send(Cmd::Stop);
}

#[test]
fn decisions_get_their_cards_details() {
    let meta = |name: &str| CardMeta {
        oracle_id: "x".into(),
        image: Some(format!("https://img/{name}.jpg")),
        back_image: None,
        art: Some(format!("https://art/{name}.jpg")),
        artist: Some("An Artist".into()),
        mana_cost: None,
        type_line: "Instant".into(),
        oracle_text: format!("{name} text."),
    };
    let e = engine();
    let mut m = e.new_match_first(5, vec![deck(&[("Island", 99)]), deck(&[("Island", 99)])], &[], Some(0)).unwrap();
    let d = m.decision(0).unwrap();
    let mull = d.options.iter().find(|o| o.kind == OptionKind::Mulligan).unwrap().index;
    m.choose(0, d.revision, mull).unwrap();
    let d = m.decision(0).unwrap();
    m.choose(0, d.revision, d.options.iter().find(|o| o.kind == OptionKind::Mulligan).unwrap().index).unwrap();
    let d = m.decision(0).unwrap();
    m.choose(0, d.revision, d.options.iter().find(|o| o.kind == OptionKind::Keep).unwrap().index).unwrap();
    let mut view = m.view(Some(0));
    let cards = HashMap::from([("Island".to_string(), meta("Island"))]);
    dress_pending(&mut view, &cards);
    let p = view.decision.unwrap().pending.unwrap();
    assert!(p.options.iter().all(|o| o.img.as_deref() == Some("https://img/Island.jpg") && o.artist.as_deref() == Some("An Artist")));
}

#[tokio::test]
async fn turn_controls_are_saved_per_account_and_apply_to_live_games() {
    let pool = crate::db::test_pool().await;
    let (user, _) = crate::testutil::user(&pool, "ana@example.com").await;
    assert_eq!(load_prefs(&pool, &user).await.unwrap(), None);
    // Only steps phase has are kept.
    let sent = Stops { own: ["Upkeep".to_string(), "Teatime".to_string()].into(), others: ["End".to_string()].into() };
    let prefs = PlayPrefs { stops: Some(clean_stops(sent)), full_control: true, tap_mana: PayMode::Manual };
    save_prefs(&pool, &user, &prefs).await.unwrap();
    let back = load_prefs(&pool, &user).await.unwrap().unwrap();
    assert_eq!(back, prefs);
    assert!(back.stops.as_ref().unwrap().own.contains("Upkeep") && !back.stops.as_ref().unwrap().own.contains("Teatime"));
    // Saving again replaces them.
    save_prefs(&pool, &user, &PlayPrefs::default()).await.unwrap();
    assert_eq!(load_prefs(&pool, &user).await.unwrap(), Some(PlayPrefs::default()));

    // A live game starts with each seat's saved settings, and its board says what they are.
    let hub = Arc::new(PlayHub { engine: Mutex::new(EngineState::Ready(Arc::new(engine()))), live: Mutex::new(HashMap::new()) });
    let m = engine().new_match_first(5, vec![deck(&[("Mountain", 99)]), deck(&[("Forest", 99)])], &[], Some(0)).unwrap();
    let saved = HashMap::from([(0u8, PlayPrefs { stops: None, full_control: true, tap_mana: PayMode::Auto })]);
    hub.spawn_game("game-turns-1".into(), m, vec![seat(0, "Ana"), seat(1, "Ben")], saved, pool.clone());
    let live = hub.live("game-turns-1").unwrap();
    let mine = board(&live, 0).await.turns.expect("a person's board has their controls");
    assert!(mine.full_control);
    assert_eq!(mine.tap_mana, PayMode::Auto, "and how their spells pay");
    assert!(!board(&live, 1).await.turns.unwrap().full_control);
    assert_eq!(board(&live, 1).await.turns.unwrap().tap_mana, PayMode::Ask);

    // A way to pass while it isn't your priority is kept for when it is.
    choose(&live, 0, OptionKind::Keep).await;
    choose(&live, 1, OptionKind::Keep).await;
    let v = board(&live, 1).await;
    send(&live, |reply| Cmd::Passing { seat: 1, revision: v.revision, mode: Some(PassMode::Mine), reply }).await.unwrap();
    let mut passing = None;
    for _ in 0..100 {
        passing = board(&live, 1).await.turns.unwrap().passing;
        if passing.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(passing, Some(PassMode::Mine));
    // The auto-tap preview answers, even when there's nothing to preview (no priority yet).
    let (tx, rx) = oneshot::channel();
    live.cmds.send(Cmd::Preview { seat: 0, object: 1, reply: tx }).unwrap();
    assert_eq!(rx.await.unwrap(), Vec::<u64>::new());
    let _ = live.cmds.send(Cmd::Stop);
}

#[tokio::test]
async fn the_host_starts_a_rematch_and_the_other_players_can_join_it() {
    use crate::testutil::{deck as make_deck, send as request, user};
    use axum::http::{Method, StatusCode};
    let mut st = crate::testutil::state().await;
    st.play = Arc::new(PlayHub { engine: Mutex::new(EngineState::Ready(Arc::new(engine()))), live: Mutex::new(HashMap::new()) });
    let pool = st.pool.clone();
    let app = crate::routes::app(st);
    let (host, host_token) = user(&pool, "ana@example.com").await;
    let (friend, friend_token) = user(&pool, "ben@example.com").await;
    let (_, stranger_token) = user(&pool, "cat@example.com").await;
    let (host_deck, host_version) = make_deck(&pool, &host, "Ana's deck").await;
    let (ai_deck, ai_version) = make_deck(&pool, &host, "Computer's deck").await;
    let (friend_deck, friend_version) = make_deck(&pool, &friend, "Ben's deck").await;

    // A finished game: Ana hosted, Ben joined, a computer played Ana's other deck.
    let seat = |n: u8, kind: &str, user: Option<&str>, deck: &str, version: &str| SeatCfg {
        seat: n,
        kind: kind.into(),
        user_id: user.map(str::to_string),
        name: format!("Seat {n}"),
        deck_id: Some(deck.into()),
        deck_version_id: Some(version.into()),
        deck_name: Some("A deck".into()),
        color_identity: String::new(),
        commander: None,
        difficulty: (kind == "ai").then(|| "Hard".into()),
        bracket: None,
    };
    let seats = vec![seat(0, "human", Some(&host), &host_deck, &host_version), seat(1, "human", Some(&friend), &friend_deck, &friend_version), seat(2, "ai", None, &ai_deck, &ai_version)];
    sqlx::query("INSERT INTO games (id, mode, created_by, format, status, starting_life, started_at, ended_at) VALUES ('old', 'online', ?, 'commander', 'finished', 40, '2026-10-24T10:00:00Z', '2026-10-24T11:12:00Z')")
        .bind(&host)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO online_games (game_id, code, host_id, stage, seats, created_at, updated_at) VALUES ('old', 'OLDOLD', ?, 'over', ?, '2026-10-24T09:58:00Z', '2026-10-24T11:12:00Z')")
        .bind(&host)
        .bind(serde_json::to_string(&seats).unwrap())
        .execute(&pool)
        .await
        .unwrap();

    // Only the host starts it.
    assert_eq!(request(&app, Method::POST, "/api/play/old/rematch", Some(&friend_token), None).await.0, StatusCode::FORBIDDEN);
    let (status, made) = request(&app, Method::POST, "/api/play/old/rematch", Some(&host_token), None).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    let new_id = made["id"].as_str().unwrap().to_string();
    // Same seats: Ana's deck, the computer's deck and level, Ben's seat open for him.
    let r = load_row(&pool, &new_id).await.unwrap();
    assert_eq!(r.stage, "lobby");
    let again = r.seats();
    assert_eq!((again[0].user_id.as_deref(), again[0].deck_id.as_deref()), (Some(host.as_str()), Some(host_deck.as_str())));
    assert_eq!((again[1].kind.as_str(), again[1].user_id.as_deref()), ("human", None));
    assert_eq!((again[2].kind.as_str(), again[2].deck_id.as_deref(), again[2].difficulty.as_deref()), ("ai", Some(ai_deck.as_str()), Some("Hard")));
    // A second tap gives the same rematch.
    assert_eq!(request(&app, Method::POST, "/api/play/old/rematch", Some(&host_token), None).await.1["id"], new_id.as_str());

    // Ben's game-over screen learns of it, with the code and his deck from that game.
    let (_, old) = request(&app, Method::GET, "/api/play/old", Some(&friend_token), None).await;
    assert_eq!(old["rematch"]["id"], new_id.as_str());
    assert_eq!(old["rematch"]["code"], r.code.as_str());
    assert_eq!(old["rematch"]["deck_id"], friend_deck.as_str());
    assert_eq!((old["started_at"].as_str(), old["ended_at"].as_str()), (Some("2026-10-24T10:00:00Z"), Some("2026-10-24T11:12:00Z")));
    // Nobody outside the game sees it.
    assert_eq!(request(&app, Method::GET, "/api/play/old", Some(&stranger_token), None).await.0, StatusCode::NOT_FOUND);
    let (status, _) = request(&app, Method::POST, "/api/play/join", Some(&friend_token), Some(serde_json::json!({ "code": r.code, "deck_id": friend_deck }))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(load_row(&pool, &new_id).await.unwrap().seats()[1].user_id.as_deref(), Some(friend.as_str()));
}

#[test]
fn card_details_cover_what_the_viewer_was_told_happened() {
    let e = engine();
    let m = e.new_match_first(5, vec![deck(&[("Island", 99)]), deck(&[("Island", 99)])], &[], Some(0)).unwrap();
    let mut view = m.view(Some(0));
    view.events.push(yama_play::Happening {
        seq: 1,
        turn: 1,
        active: 0,
        what: yama_play::feed::What::Revealed { seat: 1, cards: vec![yama_play::feed::Seen { id: None, name: Some("Preordain".into()), face_down: false }] },
    });
    assert!(view_names(&view).contains(&"Preordain".to_string()));
}
