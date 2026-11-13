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
    SeatDeck { companion: vec![], commander: vec!["Combat Celebrant".into()], main: cards.iter().flat_map(|(name, n)| vec![name.to_string(); *n]).collect() }
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
    // Ways to cast, permanents and counters (play/src/ways.rs).
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"cast_offer","cast":true,"payment":"manual"}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"cast_offer","cast":false}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_adventure_face","creature":false}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_modal_face","back_face":true}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_alternative_cast","alternative":true}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_casting_variant","index":1}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_mutate_side","top":false}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_legend","keep":12}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_ring_bearer","target":12}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"equip","equipment":9,"target":12}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"select_targets","targets":[{"kind":"object","id":7},{"kind":"player","seat":1}]}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"move_counters","moves":[{"on":7,"counter":"P1P1","count":2}]}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"remove_counters","counters":[{"counter":"stun","count":1}]}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"remove_counter_cost","counters":[{"on":7,"counter":"P1P1","count":1}]}}"#));
    // Everyone takes part, choosing a player, and the library (play/src/together.rs, library.rs).
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"submit_vote_candidate","candidate":2}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"submit_pile_partition","pile_a":[7,9]}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_pile","pile":"b"}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_branch","index":1}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"select_coin_flips","keep":[0]}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"select_die_rolls","ignore":[1]}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_top_or_bottom","top":false}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"redistribute_life","option":0}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_player","seat":2}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"learn","discard":null}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_pile","pile":"c"}}"#));
    // The rarer cards and rules, special actions and Yama's remembered answers (play/src/rare.rs, remember.rs).
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"declare_companion","name":"Jegantha, the Wellspring"}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"declare_companion","name":null}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_meld_pair","source":7,"partner":9}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_entry_attack_target","target":{"kind":"player","seat":1}}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"cipher_encode","creature":12}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_dungeon","dungeon":"LostMineOfPhandelver"}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_dungeon_room","room":2}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"time_travel","remove":[{"kind":"object","id":7}],"add":[]}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"propose_shortcut","count":20}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"decline_shortcut"}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"respond_to_shortcut","stop_at":5}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"ninjutsu","card":4,"attacker":9}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"turn_face_up","object":4}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"foretell","object":4}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"companion_to_hand"}}"#));
    assert!(ok(r#"{"type":"act","revision":3,"action":{"kind":"use_serum_powder","object":4}}"#));
    assert!(ok(r#"{"type":"act","revision":0,"action":{"kind":"remember_answer","accept":true}}"#));
    assert!(ok(r#"{"type":"act","revision":0,"action":{"kind":"forget_answer","id":"y0123"}}"#));
    // Not the engine's own forms: a free face-down play, a shortcut with its own template.
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"play_face_down","object_id":4,"card_id":4}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"declare_shortcut","count":{"Fixed":2}}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"activate_ninjutsu","ninjutsu_object_id":4,"creature_to_return":9}}"#));
    // Not the engine's own forms of them.
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_gift_recipient","opponent":2}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_pile_opponent","opponent":2}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"learn_decision","choice":{"type":"Skip"}}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"cascade_choice","choice":{"type":"Cast"}}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"cast_spell_as_madness","object_id":4,"card_id":4}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_counter_move_distribution","selections":[]}}"#));
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
    let hub = Arc::new(PlayHub { engine: Mutex::new(EngineState::Ready(Arc::new(engine()))), live: Mutex::new(HashMap::new()), historical: None, historical_v0119: None, setup_gate: Arc::new(tokio::sync::Semaphore::new(1)), unavailable: Mutex::new(HashMap::new()) });
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
        faces: None,
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
    let cards = BTreeMap::from([("Island".to_string(), meta("Island"))]);
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
    let hub = Arc::new(PlayHub { engine: Mutex::new(EngineState::Ready(Arc::new(engine()))), live: Mutex::new(HashMap::new()), historical: None, historical_v0119: None, setup_gate: Arc::new(tokio::sync::Semaphore::new(1)), unavailable: Mutex::new(HashMap::new()) });
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
    assert_eq!(rx.await.unwrap().unwrap(), Vec::<u64>::new());
    let _ = live.cmds.send(Cmd::Stop);
}

#[tokio::test]
async fn phase_board_preferences_carry_to_the_next_game_without_overwriting_other_settings() {
    async fn action(live: &LiveGame, seat: u8, value: serde_json::Value) -> Result<(), yama_play::board::Rejection> {
        let (reply, result) = oneshot::channel();
        let action = serde_json::from_value(value.clone()).unwrap_or_else(|e| panic!("{value}: {e}"));
        live.cmds.send(Cmd::Board { seat, mv: board::Move::Action(action), reply }).unwrap();
        result.await.unwrap()
    }
    let pool = crate::db::test_pool().await;
    let (ana, _) = crate::testutil::user(&pool, "board-prefs-ana@example.com").await;
    let (ben, _) = crate::testutil::user(&pool, "board-prefs-ben@example.com").await;
    let account = PlayPrefs {
        stops: Some(Stops { own: ["End".into()].into(), others: Default::default() }),
        full_control: false,
        tap_mana: PayMode::Manual,
    };
    save_prefs(&pool, &ana, &account).await.unwrap();
    let mut seats = vec![seat(0, "Ana"), seat(1, "Ben")];
    seats[0].user_id = Some(ana.clone());
    seats[1].user_id = Some(ben.clone());
    let hub = ready_hub(None);
    let m = engine().new_match_first(5, vec![deck(&[("Island", 99)]), deck(&[("Forest", 99)])], &[], Some(0)).unwrap();
    // A recovered game can differ from account defaults. Reasserting its current
    // setting must still save the explicit choice, without copying its other fields.
    let recovered = PlayPrefs { stops: None, full_control: true, tap_mana: PayMode::Auto };
    hub.spawn_game("board-prefs-first".into(), m, seats.clone(), HashMap::from([(0, recovered)]), pool.clone());
    let live = hub.live("board-prefs-first").unwrap();
    action(&live, 0, serde_json::json!({"type":"SetPriorityPassingMode","data":{"mode":"FullControl"}})).await.unwrap();
    let mut expected = PlayPrefs { full_control: true, ..account };
    assert_eq!(load_prefs(&pool, &ana).await.unwrap(), Some(expected.clone()));
    assert_eq!(load_prefs(&pool, &ben).await.unwrap(), None, "another seat's defaults stay private");

    action(&live, 0, serde_json::json!({"type":"SetPhaseStops","data":{"stops":[
        {"phase":"Upkeep","scope":"OwnTurn"}, {"phase":"End","scope":"OpponentsTurns"}
    ]}})).await.unwrap();
    expected.stops = Some(Stops { own: ["Upkeep".into()].into(), others: ["End".into()].into() });
    assert_eq!(load_prefs(&pool, &ana).await.unwrap(), Some(expected.clone()));
    // Another game's account change must survive a stop-only change here.
    expected.full_control = false;
    save_prefs(&pool, &ana, &expected).await.unwrap();
    action(&live, 0, serde_json::json!({"type":"SetPhaseStops","data":{"stops":[]}})).await.unwrap();
    expected.stops = None;
    assert_eq!(load_prefs(&pool, &ana).await.unwrap(), Some(expected.clone()));
    action(&live, 0, serde_json::json!({"type":"MulliganDecision","data":{"choice":{"type":"Keep"}}})).await.unwrap();
    assert_eq!(load_prefs(&pool, &ana).await.unwrap(), Some(expected.clone()), "ordinary moves don't write defaults");
    assert!(action(&live, 0, serde_json::json!({"type":"Concede","data":{"player_id":0}})).await.is_err());
    assert_eq!(load_prefs(&pool, &ana).await.unwrap(), Some(expected.clone()), "refused moves don't write defaults");

    // First-time preferences create only this seat's account row.
    action(&live, 1, serde_json::json!({"type":"SetPhaseStops","data":{"stops":["Draw"]}})).await.unwrap();
    let ben_prefs = load_prefs(&pool, &ben).await.unwrap().unwrap();
    assert!(!ben_prefs.full_control);
    assert_eq!(ben_prefs.tap_mana, PayMode::Ask);
    assert_eq!(ben_prefs.stops, Some(Stops { own: ["Draw".into()].into(), others: ["Draw".into()].into() }));
    action(&live, 1, serde_json::json!({"type":"SetPriorityPassingMode","data":{"mode":"FullControl"}})).await.unwrap();
    action(&live, 1, serde_json::json!({"type":"SetPriorityPassingMode","data":{"mode":"Standard"}})).await.unwrap();
    assert_eq!(load_prefs(&pool, &ben).await.unwrap(), Some(ben_prefs));
    hub.stop("board-prefs-first");

    let saved = seat_prefs(&pool, &seats).await;
    let m = engine().new_match_first(6, vec![deck(&[("Island", 99)]), deck(&[("Forest", 99)])], &[], Some(0)).unwrap();
    hub.spawn_game("board-prefs-next".into(), m, seats, saved, pool.clone());
    let next = hub.live("board-prefs-next").unwrap();
    let controls = board(&next, 0).await.turns.unwrap();
    assert_eq!(controls.full_control, expected.full_control);
    assert_eq!(controls.stops, expected.stops);
    assert_eq!(controls.tap_mana, expected.tap_mana);
    hub.stop("board-prefs-next");
}

#[tokio::test(flavor = "current_thread")]
async fn slow_setup_leaves_the_async_runtime_and_database_available() {
    let pool = crate::db::test_pool().await;
    let (owner, _) = crate::testutil::user(&pool, "setup-write@example.com").await;
    let (entered, ready) = oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let setup = tokio::spawn(prepare_match(move || {
        entered.send(()).unwrap();
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
        Ok(42)
    }));
    tokio::time::timeout(Duration::from_secs(2), ready).await.unwrap().unwrap();
    // This current-thread runtime must keep serving writes while setup is stalled.
    let mut tx = tokio::time::timeout(Duration::from_secs(2), pool.begin()).await.unwrap().unwrap();
    sqlx::query("INSERT INTO games(id, mode, created_by, status, started_at) VALUES ('setup-unrelated', 'in_person', ?, 'in_progress', '2026-11-10')")
        .bind(owner).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    release.send(()).unwrap();
    assert_eq!(setup.await.unwrap().unwrap(), 42);
    let error = prepare_match(|| -> anyhow::Result<()> { anyhow::bail!("setup failed") }).await.unwrap_err();
    assert!(format!("{error:?}").contains("setup failed"));
}

#[tokio::test]
async fn cancelled_setup_keeps_its_slot_until_the_worker_exits() {
    let gate = Arc::new(tokio::sync::Semaphore::new(1));
    let permit = gate.clone().acquire_owned().await.unwrap();
    let (entered, ready) = oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let task = tokio::spawn(prepare_match(move || {
        entered.send(()).unwrap();
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
        Ok(permit)
    }));
    ready.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(gate.clone().try_acquire_owned().is_err(), "cancelled HTTP cannot admit another setup while its worker runs");
    release.send(()).unwrap();
    let _next = tokio::time::timeout(Duration::from_secs(2), gate.acquire()).await.unwrap().unwrap();
}

#[tokio::test]
async fn failed_start_keeps_the_lobby_and_a_retry_starts_once() {
    use crate::testutil::{deck as make_deck, user};
    let mut st = crate::testutil::state().await;
    st.play = ready_hub(None);
    let pool = st.pool.clone();
    let (host, _) = user(&pool, "start-host@example.com").await;
    let (friend, _) = user(&pool, "start-friend@example.com").await;
    let (host_deck, host_version) = make_deck(&pool, &host, "Host").await;
    let (friend_deck, friend_version) = make_deck(&pool, &friend, "Friend").await;
    let cards = vec![
        crate::decks::DeckCard { oracle_id: "commander".into(), name: "Combat Celebrant".into(), qty: 1, board: crate::decks::Board::Commander },
        crate::decks::DeckCard { oracle_id: "land".into(), name: "Island".into(), qty: 99, board: crate::decks::Board::Main },
    ];
    for version in [&host_version, &friend_version] {
        sqlx::query("UPDATE deck_versions SET cards=? WHERE id=?")
            .bind(serde_json::to_string(&cards).unwrap()).bind(version).execute(&pool).await.unwrap();
    }
    let seats: Vec<_> = [(&host, &host_deck, &host_version), (&friend, &friend_deck, &friend_version)]
        .into_iter().enumerate().map(|(n, (user, deck, version))| {
            let mut s = seat(n as u8, "Player");
            s.user_id = Some(user.to_string());
            s.deck_id = Some(deck.to_string());
            s.deck_version_id = Some(version.to_string());
            s
        }).collect();
    sqlx::query("INSERT INTO games(id,mode,created_by,status,started_at) VALUES('start-failure','online',?,'in_progress','2026-11-02T00:00:00Z')")
        .bind(&host).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO online_games(game_id,code,host_id,stage,seats,created_at,updated_at) VALUES('start-failure','START0',?,'lobby',?,'2026-11-02T00:00:00Z','2026-11-02T00:00:00Z')")
        .bind(&host).bind(serde_json::to_string(&seats).unwrap()).execute(&pool).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_initial_replay BEFORE UPDATE OF replay ON online_games WHEN NEW.game_id='start-failure' AND NEW.replay IS NOT NULL BEGIN SELECT RAISE(ABORT,'simulated initial replay write failure'); END")
        .execute(&pool).await.unwrap();

    let error = start_game(&st, "start-failure", &host).await.unwrap_err();
    assert!(format!("{error:?}").contains("simulated initial replay write failure"));
    let r = load_row(&pool, "start-failure").await.unwrap();
    assert_eq!(r.stage, "lobby", "failed persistence must not leave an unknown live game");
    assert_eq!(r.updated_at, "2026-11-02T00:00:00Z");
    assert_eq!(r.engine_version, None);
    assert!(st.play.game_error(&r).is_none());
    let saved: (Option<i64>, Option<String>, i64) = sqlx::query_as("SELECT g.seed,o.replay,o.revision FROM games g JOIN online_games o ON o.game_id=g.id WHERE g.id='start-failure'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(saved, (None, None, 0));
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM game_seats WHERE game_id='start-failure'").fetch_one(&pool).await.unwrap(), 0);
    assert!(st.play.live("start-failure").is_none());

    sqlx::query("DROP TRIGGER reject_initial_replay").execute(&pool).await.unwrap();
    let (first, second) = tokio::join!(start_game(&st, "start-failure", &host), start_game(&st, "start-failure", &host));
    first.unwrap();
    second.unwrap();
    let r = load_row(&pool, "start-failure").await.unwrap();
    assert_eq!(r.stage, "live");
    assert_eq!(r.engine_version.as_deref(), Some(yama_play::ENGINE_VERSION));
    let live = st.play.live("start-failure").unwrap();
    board(&live, 0).await;
    let saved: (i64, String) = sqlx::query_as("SELECT g.seed,o.replay FROM games g JOIN online_games o ON o.game_id=g.id WHERE g.id='start-failure'")
        .fetch_one(&pool).await.unwrap();
    let replay: serde_json::Value = serde_json::from_str(&saved.1).unwrap();
    assert_eq!(replay["header"]["seed"].as_u64(), Some(saved.0 as u64));
    start_game(&st, "start-failure", &host).await.unwrap();
    let after: (i64, String) = sqlx::query_as("SELECT g.seed,o.replay FROM games g JOIN online_games o ON o.game_id=g.id WHERE g.id='start-failure'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(after, saved, "another start cannot replace the committed game");
    st.play.stop("start-failure");
}

#[tokio::test]
async fn the_host_starts_a_rematch_and_the_other_players_can_join_it() {
    use crate::testutil::{deck as make_deck, send as request, user};
    use axum::http::{Method, StatusCode};
    let mut st = crate::testutil::state().await;
    st.play = Arc::new(PlayHub { engine: Mutex::new(EngineState::Ready(Arc::new(engine()))), live: Mutex::new(HashMap::new()), historical: None, historical_v0119: None, setup_gate: Arc::new(tokio::sync::Semaphore::new(1)), unavailable: Mutex::new(HashMap::new()), });
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
    let seats = vec![seat(0, "human", Some(&host), &host_deck, &host_version), seat(1, "human", Some(&friend), &friend_deck, &friend_version), seat(2, "ai", None, &ai_deck, &ai_version),];
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

    // A host cannot end a whole table with other humans in it.
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/play/old/end",
            Some(&host_token),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    // Only the host starts it.
    assert_eq!(request(&app, Method::POST, "/api/play/old/rematch", Some(&friend_token), None).await.0, StatusCode::FORBIDDEN);
    let (status, made) = request(&app, Method::POST, "/api/play/old/rematch", Some(&host_token), None,).await;
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
    let (_, old) = request(&app, Method::GET, "/api/play/old", Some(&friend_token), None,).await;
    assert_eq!(old["rematch"]["id"], new_id.as_str());
    assert_eq!(old["rematch"]["code"], r.code.as_str());
    assert_eq!(old["rematch"]["deck_id"], friend_deck.as_str());
    assert_eq!((old["started_at"].as_str(), old["ended_at"].as_str()), (Some("2026-10-24T10:00:00Z"), Some("2026-10-24T11:12:00Z")));
    // Nobody outside the game sees it.
    assert_eq!(request(&app, Method::GET, "/api/play/old", Some(&stranger_token), None).await.0, StatusCode::NOT_FOUND);
    let (status, _) = request(&app, Method::POST, "/api/play/join", Some(&friend_token), Some(serde_json::json!({ "code": r.code, "deck_id": friend_deck })),).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(load_row(&pool, &new_id).await.unwrap().seats()[1].user_id.as_deref(), Some(friend.as_str())
    );
    // A solo rematch also waits in a lobby instead of creating an unexpected live game.
    let solo: Vec<_> = seats
        .into_iter()
        .filter(|s| s.kind == "ai" || s.user_id.as_deref() == Some(host.as_str()))
        .collect();
    sqlx::query("UPDATE online_games SET seats=?, rematch_id=NULL WHERE game_id='old'")
        .bind(serde_json::to_string(&solo).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let (status, made) = request(
        &app,
        Method::POST,
        "/api/play/old/rematch",
        Some(&host_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{made}");
    assert_eq!(
        load_row(&pool, made["id"].as_str().unwrap())
            .await
            .unwrap()
            .stage,
        "lobby");
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

#[test]
fn a_cards_faces_go_to_the_board_as_words_only() {
    // As imported from Scryfall (cards.faces): each face's words, and fields the board doesn't use.
    let stored = r#"[{"name":"Bonecrusher Giant","mana_cost":"{2}{R}","type_line":"Creature — Giant","oracle_text":"Whenever this creature becomes the target of a spell, this creature deals 2 damage to that spell's controller.","colors":null,"power":"4","toughness":"3","loyalty":null,"oracle_id":null},{"name":"Stomp","mana_cost":"{1}{R}","type_line":"Instant — Adventure","oracle_text":"Damage can't be prevented this turn. Stomp deals 2 damage to any target.","colors":null,"power":null,"toughness":null,"loyalty":null,"oracle_id":null}]"#;
    let meta = CardMeta {
        oracle_id: "x".into(),
        image: None,
        back_image: None,
        art: None,
        artist: None,
        mana_cost: Some("{2}{R} // {1}{R}".into()),
        type_line: "Creature — Giant // Instant — Adventure".into(),
        oracle_text: String::new(),
        faces: Some(stored.into()),
    };
    let v = serde_json::to_value(&meta).unwrap();
    assert_eq!(v["faces"][1], serde_json::json!({ "name": "Stomp", "mana_cost": "{1}{R}", "type_line": "Instant — Adventure", "oracle_text": "Damage can't be prevented this turn. Stomp deals 2 damage to any target." }));
    assert!(v["faces"][0].get("power").is_none());
    // A one-faced card sends none.
    let plain = CardMeta { faces: None, ..meta };
    assert!(serde_json::to_value(&plain).unwrap().get("faces").is_none());
}

#[test]
fn a_companion_comes_from_the_decks_sideboard() {
    let e = Engine::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../play/tests/fixtures/rare-cards.json")).unwrap();
    let card = |name: &str, qty: i64, board: Board| DeckCard { oracle_id: String::new(), name: name.into(), qty, board };
    let cards = vec![
        card("Kenrith, the Returned King", 1, Board::Commander),
        card("Mountain", 99, Board::Main),
        card("Shock", 1, Board::Side),
        card("Jegantha, the Wellspring", 1, Board::Side),
    ];
    let (deck, report) = resolve(&e, &cards);
    assert!(report.missing.is_empty());
    assert_eq!(deck.companion, ["Jegantha, the Wellspring"], "the first sideboard card with the keyword");
    assert_eq!(deck.main.len(), 99, "the sideboard stays out of the deck");
    let (none, _) = resolve(&e, &cards[..3]);
    assert!(none.companion.is_empty());
}

#[tokio::test]
async fn remembered_answers_are_saved_with_the_game() {
    let st = crate::testutil::state().await;
    let pool = st.pool.clone();
    let (host, _) = crate::testutil::user(&pool, "ana@example.com").await;
    let e = engine();
    let mut m = e.new_match_first(5, vec![deck(&[("Island", 99)]), deck(&[("Island", 99)])], &[], Some(0)).unwrap();
    let answers: Vec<yama_play::YamaAnswer> = serde_json::from_value(serde_json::json!([
        { "id": "y1", "seat": 0, "kind": "pay", "card": "Rhystic Study", "owner": 1, "cost": "{1}", "accept": true }
    ]))
    .unwrap();
    m.set_remembered(answers.clone());
    sqlx::query("INSERT INTO games (id, mode, created_by, format, status, starting_life, started_at) VALUES ('g', 'online', ?, 'commander', 'in_progress', 40, '2026-10-24T10:00:00Z')")
        .bind(&host)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO online_games (game_id, code, host_id, stage, seats, created_at, updated_at) VALUES ('g', 'GGGGGG', ?, 'live', '[]', 'now', 'now')")
        .bind(&host)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE games SET engine_version=? WHERE id='g'").bind(yama_play::ENGINE_VERSION).execute(&pool).await.unwrap();
    persist(&pool, "g", &m, false).await.unwrap();
    let (saved,): (Option<String>,) = sqlx::query_as("SELECT answers FROM online_games WHERE game_id = 'g'").fetch_one(&pool).await.unwrap();
    let back: Vec<yama_play::YamaAnswer> = serde_json::from_str(&saved.unwrap()).unwrap();
    assert_eq!(back, answers);
    // None remembered: nothing stored.
    m.set_remembered(vec![]);
    persist(&pool, "g", &m, false).await.unwrap();
    let (saved,): (Option<String>,) = sqlx::query_as("SELECT answers FROM online_games WHERE game_id = 'g'").fetch_one(&pool).await.unwrap();
    assert_eq!(saved, None);
}

#[tokio::test]
async fn online_games_start_with_loop_detection_and_save_it() {
    use crate::testutil::{send as request, user};
    use axum::http::{Method, StatusCode};
    let mut st = crate::testutil::state().await;
    st.play = Arc::new(PlayHub { engine: Mutex::new(EngineState::Ready(Arc::new(engine()))), live: Mutex::new(HashMap::new()), historical: None, historical_v0119: None, setup_gate: Arc::new(tokio::sync::Semaphore::new(1)), unavailable: Mutex::new(HashMap::new()) });
    let hub = st.play.clone();
    let pool = st.pool.clone();
    let app = crate::routes::app(st);
    let (host, token) = user(&pool, "ana@example.com").await;
    let cards = || {
        let mut cards = vec![crate::decks::DeckCard { oracle_id: "x-celebrant".into(), name: "Combat Celebrant".into(), qty: 1, board: Board::Commander }];
        cards.push(crate::decks::DeckCard { oracle_id: "x-mountain".into(), name: "Mountain".into(), qty: 99, board: Board::Main });
        cards
    };
    let mine = crate::decks::create_deck_with_cards(&pool, &host, "Ana's deck", None, cards()).await.unwrap();
    let theirs = crate::decks::create_deck_with_cards(&pool, &host, "Computer's deck", None, cards()).await.unwrap();
    let body = serde_json::json!({ "seats": [{ "kind": "me", "deck_id": mine }, { "kind": "ai", "deck_id": theirs, "difficulty": "Easy" }] });
    let (status, made) = request(&app, Method::POST, "/api/play", Some(&token), Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    let id = made["id"].as_str().unwrap().to_string();
    // With no one to wait for, it started at once; its replay log's header carries the setting, so
    // a restart or a replay plays it the same way.
    let (replay,): (Option<String>,) = sqlx::query_as("SELECT replay FROM online_games WHERE game_id = ?").bind(&id).fetch_one(&pool).await.unwrap();
    let replay: serde_json::Value = serde_json::from_str(&replay.expect("saved when it started")).unwrap();
    assert_eq!(replay["header"]["match_config"]["loop_detection"], serde_json::json!({ "type": "Interactive" }));
    let resumed = engine().resume(&replay.to_string(), &[(1, Difficulty::Easy)]).unwrap();
    assert_eq!(resumed.loops(), yama_play::LoopDetectionMode::Interactive);
    // The games list says whose turn it is and whether it's your move, without the board.
    let mut item = serde_json::Value::Null;
    for _ in 0..100 {
        let (status, list) = request(&app, Method::GET, "/api/play", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        item = list.as_array().unwrap().iter().find(|g| g["id"] == id.as_str()).cloned().unwrap();
        if item.get("turn").is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(item["turn"].as_u64().is_some_and(|t| t >= 1), "{item}");
    assert!(item["active"].as_u64().is_some(), "{item}");
    assert!(item["your_move"].is_boolean(), "{item}");
    hub.stop(&id);
}

async fn saved_game(pool: &SqlitePool, id: &str, host: &str, identity: Option<&str>, stage: &str, replay: &str) {
    let mut seats = vec![seat(0, "Ana"), seat(1, "Ben")];
    seats[0].user_id = Some(host.into());
    seats[1].user_id = None;
    sqlx::query("INSERT INTO games(id,mode,created_by,format,status,starting_life,started_at,engine_version) VALUES (?,'online',?,'commander',?,40,'original',?)")
        .bind(id).bind(host).bind(if stage=="over" {"finished"} else {"in_progress"}).bind(identity).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO online_games(game_id,code,host_id,stage,seats,replay,log,answers,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,NULL,0,'original','original')")
        .bind(id).bind(id).bind(host).bind(stage).bind(serde_json::to_string(&seats).unwrap()).bind(replay).execute(pool).await.unwrap();
}
async fn saved_bytes(pool: &SqlitePool, id: &str) -> String {
    sqlx::query_scalar("SELECT json_object('engine',g.engine_version,'status',g.status,'replay',o.replay,'log',o.log,'answers',o.answers,'seats',o.seats,'revision',o.revision,'stage',o.stage,'updated',o.updated_at) FROM games g JOIN online_games o ON o.game_id=g.id WHERE g.id=?")
        .bind(id).fetch_one(pool).await.unwrap()
}
fn ready_hub(historical: Option<history::Config>) -> Arc<PlayHub> {
    let (historical, historical_v0119) = match historical {
        Some(config) if config.identity() == history::V0119_IDENTITY => (None, Some(config)),
        other => (other, None),
    };
    Arc::new(PlayHub {
        engine: Mutex::new(EngineState::Ready(Arc::new(engine()))),
        live: Mutex::new(HashMap::new()),
        historical,
        historical_v0119,
        setup_gate: Arc::new(tokio::sync::Semaphore::new(1)), unavailable: Mutex::new(HashMap::new()),
    })
}

#[tokio::test]
async fn recovery_checks_identity_before_replay_and_preserves_live_and_completed_storage() {
    use crate::testutil::{send as request, user};
    use axum::http::{Method, StatusCode};
    let mut st = crate::testutil::state().await;
    st.play = ready_hub(None);
    let hub = st.play.clone();
    let pool = st.pool.clone();
    let (host, token) = user(&pool, "owner@example.com").await;
    let (_, stranger) = user(&pool, "stranger@example.com").await;
    let cases = [
        ("missing-live", None, "live"),
        ("unknown-live", Some("unregistered-engine"), "live"),
        ("old-live", Some(history::IDENTITY), "live"),
        ("unknown-over", Some("unregistered-engine"), "over"),
        ("missing-over", None, "over"),
        ("old-over", Some(history::IDENTITY), "over"),
    ];
    for (id, version, stage) in cases {
        saved_game(&pool, id, &host, version, stage, "NOT JSON: must never be parsed").await;
    }
    let before: Vec<_> = futures_util::future::join_all(cases.iter().map(|(id, _, _)| saved_bytes(&pool, id))).await;
    // With a current engine, live games on a retired one are replayed on it and moved over or
    // closed (games_on_a_retired_engine_move_over_...); without one, nothing is parsed or changed.
    *hub.engine.lock().unwrap() = EngineState::Failed("deliberately down in the identity routing test".into());
    hub.resume_live(&pool).await;
    assert_eq!(hub.live_count(), 0);
    let app = crate::routes::app(st);
    for (i, (id, _, _)) in cases.iter().enumerate() {
        let (code, body) = request(&app, Method::GET, &format!("/api/play/{id}/view"), Some(&token), None).await;
        assert_eq!(code, StatusCode::CONFLICT, "{body}");
        assert!(body.to_string().contains("runtime") || body.to_string().contains("rules engine"), "{body}");
        let (code, _) = request(&app, Method::GET, &format!("/api/play/{id}/view"), Some(&stranger), None).await;
        assert_eq!(code, StatusCode::NOT_FOUND);
        let (code, detail) = request(&app, Method::GET, &format!("/api/play/{id}"), Some(&token), None).await;
        assert_eq!(code, StatusCode::OK);
        assert!(detail["runtime_error"].is_string());
        assert_eq!(saved_bytes(&pool, id).await, before[i]);
    }
    let (_, status) = request(&app, Method::GET, "/api/play/status", Some(&token), None).await;
    assert_eq!(status["unavailable_games"].as_array().unwrap().len(), cases.len());
    let (_, status) = request(&app, Method::GET, "/api/play/status", Some(&stranger), None).await;
    assert_eq!(status["unavailable_games"], serde_json::json!([]));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM online_game_originals").fetch_one(&pool).await.unwrap();
    assert_eq!(count, 0, "rejection must not even create an archive row");
}

#[tokio::test(flavor = "multi_thread")]
async fn matching_runtime_recovers_live_and_completed_and_fences_later_writes() {
    use crate::testutil::{send as request, user};
    use axum::http::{Method, StatusCode};
    let mut st = crate::testutil::state().await;
    st.play = ready_hub(None);
    let hub = st.play.clone();
    let pool = st.pool.clone();
    let (host, token) = user(&pool, "owner@example.com").await;
    let mut m = engine().new_match_first(19, vec![deck(&[("Island", 99)]), deck(&[("Mountain", 99)])], &[], Some(0)).unwrap();
    let original = m.replay_json();
    saved_game(&pool, "matching-live", &host, Some(yama_play::ENGINE_VERSION), "live", &original).await;
    m.concede(0).unwrap();
    saved_game(&pool, "matching-over", &host, Some(yama_play::ENGINE_VERSION), "over", &m.replay_json()).await;
    hub.resume_live(&pool).await;
    let live = hub.live("matching-live").expect("matching runtime recovers");
    assert!(!board(&live, 0).await.over);
    let app = crate::routes::app(st);
    let before = saved_bytes(&pool, "matching-over").await;
    let (code, body) = request(&app, Method::GET, "/api/play/matching-over/view", Some(&token), None).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["view"]["over"], true);
    assert_eq!(saved_bytes(&pool, "matching-over").await, before);
    hub.stop("matching-live");
    persist(&pool, "matching-live", &m, false).await.unwrap();
    let archived: String =
        sqlx::query_scalar("SELECT replay FROM online_game_originals WHERE game_id='matching-live'").fetch_one(&pool).await.unwrap();
    assert_eq!(archived, original);
    sqlx::query("UPDATE games SET engine_version='unknown' WHERE id='matching-live'").execute(&pool).await.unwrap();
    let before = saved_bytes(&pool, "matching-live").await;
    assert!(persist(&pool, "matching-live", &m, false).await.is_err());
    assert_eq!(saved_bytes(&pool, "matching-live").await, before);
    let archived_again: String =
        sqlx::query_scalar("SELECT replay FROM online_game_originals WHERE game_id='matching-live'").fetch_one(&pool).await.unwrap();
    assert_eq!(archived_again, original);
    // Account deletion removes the online record even when shared game statistics remain.
    sqlx::query("DELETE FROM online_games WHERE game_id='matching-live'").execute(&pool).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM online_game_originals").fetch_one(&pool).await.unwrap();
    assert_eq!(count, 0, "private originals follow online-record removal for account deletion");
}

#[test]
fn loaded_content_must_match_even_when_the_filename_claims_the_right_hash() {
    use sha2::{Digest, Sha256};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("card-data-cbd552b41f962f5b.json");
    let fixture = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../play/tests/fixtures/act-cards.json")).unwrap();
    std::fs::write(&path, &fixture).unwrap();
    let hash = Sha256::digest(&fixture).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    assert!(Engine::load_verified(&path, &hash).is_ok());
    let error = Engine::load_verified(&path, yama_play::CARD_DATA_SHA256).err().unwrap().to_string();
    assert!(error.contains("content mismatch"));
    std::fs::write(&path, "not JSON").unwrap();
    assert!(Engine::load_verified(&path, &hash).err().unwrap().to_string().contains("content mismatch"));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires separately built pinned historical runtime and verified full historical data"]
async fn historical_runtime_continues_live_games_and_rebuilds_final_boards_privately() {
    let config = history::Config::new(
        std::env::var_os("YAMA_HISTORICAL_RUNTIME").expect("set historical binary").into(),
        std::env::var_os("YAMA_HISTORICAL_CARD_DATA").expect("set verified historical data").into(),
    );
    exercise_historical_runtime(config).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the frozen v0.119 runtime and verified full v0.119 data"]
async fn v0119_runtime_continues_live_games_and_rebuilds_final_boards_privately() {
    let config = history::Config::for_v0119(
        std::env::var_os("YAMA_V0119_RUNTIME").expect("set v0.119 binary").into(),
        std::env::var_os("YAMA_V0119_CARD_DATA").expect("set verified v0.119 data").into(),
    );
    exercise_historical_runtime(config).await;
}

async fn exercise_historical_runtime(config: history::Config) {
    use crate::testutil::{send as request, user};
    use axum::http::{Method, StatusCode};
    let identity = config.identity();
    let output = std::process::Command::new(&config.binary).arg("--fixture").arg(&config.data).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let fixture: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let mut st = crate::testutil::state().await;
    st.play = ready_hub(Some(config.clone()));
    *st.play.engine.lock().unwrap() = EngineState::Failed("current runtime deliberately unavailable in historical routing test".into());
    let hub = st.play.clone();
    let pool = st.pool.clone();
    let (host, token) = user(&pool, "historical-owner@example.com").await;
    let (spectator, spectator_token) = user(&pool, "spectator@example.com").await;
    let (_, stranger) = user(&pool, "stranger@example.com").await;
    sqlx::query("INSERT INTO playgroups(id,name,owner_id,join_code,created_at) VALUES ('group','Group',?,'GROUP','now')")
        .bind(&host)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO playgroup_members(id,playgroup_id,user_id,created_at) VALUES ('member','group',?,'now')")
        .bind(&spectator)
        .execute(&pool)
        .await
        .unwrap();
    for stage in ["live", "over"] {
        saved_game(
            &pool,
            &format!("historical-{stage}"),
            &host,
            Some(identity),
            stage,
            fixture[stage]["replay"].as_str().unwrap(),
        )
        .await;
        sqlx::query("UPDATE online_games SET log=?,answers=? WHERE game_id=?")
            .bind(fixture[stage]["log"].to_string())
            .bind(fixture[stage]["answers"].to_string())
            .bind(format!("historical-{stage}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    let mut historical_seats = vec![seat(0, "Ana"), seat(1, "Ben")];
    historical_seats[0].user_id = Some(host.clone());
    historical_seats[1].user_id = None;
    historical_seats[1].kind = "ai".into();
    historical_seats[1].difficulty = Some("Easy".into());
    sqlx::query("UPDATE online_games SET seats=? WHERE game_id LIKE 'historical-%'")
        .bind(serde_json::to_string(&historical_seats).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE games SET playgroup_id='group' WHERE id LIKE 'historical-%'").execute(&pool).await.unwrap();
    let live_original = fixture["live"]["replay"].as_str().unwrap().to_owned();
    let over_before = saved_bytes(&pool, "historical-over").await;
    hub.resume_live(&pool).await;
    let live = hub.live("historical-live").expect("historical game must actually resume");
    let app = crate::routes::app(st);
    for stage in ["live", "over"] {
        let (code, owner) = request(&app, Method::GET, &format!("/api/play/historical-{stage}/view"), Some(&token), None).await;
        assert_eq!(code, StatusCode::OK, "{owner}");
        let (code, public) = request(&app, Method::GET, &format!("/api/play/historical-{stage}/view"), Some(&spectator_token), None).await;
        assert_eq!(code, StatusCode::OK, "{public}");
        assert!(public["you"].is_null());
        let expected = |viewer: serde_json::Value| {
            fixture[stage]["views"].as_array().unwrap().iter().find(|pair| pair[0] == viewer).unwrap()[1].clone()
        };
        assert_eq!(owner["view"], expected(serde_json::json!(0)), "correct historical participant board");
        assert_eq!(public["view"], expected(serde_json::Value::Null), "correct historical spectator board");
        let (code, _) = request(&app, Method::GET, &format!("/api/play/historical-{stage}/view"), Some(&stranger), None).await;
        assert_eq!(code, StatusCode::NOT_FOUND);
    }
    assert_eq!(saved_bytes(&pool, "historical-over").await, over_before, "final-board reads do not migrate storage");
    // Wrong actor and stale revision are refused by the historical adapter, not the new engine.
    let before = saved_bytes(&pool, "historical-live").await;
    assert!(send(&live, |reply| Cmd::Choose { seat: 0, revision: u64::MAX, index: 0, reply }).await.is_err());
    assert_eq!(saved_bytes(&pool, "historical-live").await, before);
    assert!(
        send(&live, |reply| Cmd::Choose { seat: 1, revision: fixture["live"]["revision"].as_u64().unwrap(), index: 0, reply })
            .await
            .is_err()
    );
    assert_eq!(saved_bytes(&pool, "historical-live").await, before);
    // Continue a real historical decision, then reconstruct its persisted replay with the
    // pinned adapter. Concession alone would not witness normal continuation.
    let decision = fixture["live"]["views"].as_array().unwrap().iter().find(|pair| pair[0] == 0).unwrap()[1]["decision"].clone();
    let index = decision["options"].as_array().unwrap().iter().find(|o| o["kind"] == "keep").unwrap_or(&decision["options"][0])["index"]
        .as_u64()
        .unwrap() as usize;
    let revision = decision["revision"].as_u64().unwrap();
    send(&live, |reply| Cmd::Choose { seat: 0, revision, index, reply }).await.expect("historical human decision continues");
    // A read-only queued preview is a barrier after the historical AI batch settles.
    let (preview_tx, preview_rx) = oneshot::channel();
    live.cmds.send(Cmd::Preview { seat: 0, object: 0, reply: preview_tx }).unwrap();
    preview_rx.await.unwrap().unwrap();

    let (replay, log, answers): (String, Option<String>, Option<String>) =
        sqlx::query_as("SELECT replay,log,answers FROM online_games WHERE game_id='historical-live'").fetch_one(&pool).await.unwrap();
    assert_ne!(replay, live_original, "the original runtime appended the accepted action");
    let mut golden = history::Worker::start(&config).unwrap();
    let sibling = history::Worker::start(&config).unwrap();
    assert_eq!(golden.process_id(), sibling.process_id(), "sessions share one historical database process");
    drop(sibling); // Closing another session must not terminate the shared runtime.
    let saved_seats = historical_seats.clone();
    golden.open(&config, replay, log, answers, &saved_seats).expect("accepted continuation restarts on its own runtime");
    let expected = golden.call(serde_json::json!({"op":"view","viewer":0})).unwrap();
    let (code, continued) = request(&app, Method::GET, "/api/play/historical-live/view", Some(&token), None).await;
    assert_eq!(code, StatusCode::OK);
    let mut continued_view = continued["view"].clone();
    if identity == history::V0119_IDENTITY {
        // The live process retains its just-created rewind checkpoint. Reopening
        // persists the game and audit, but intentionally starts with no checkpoint.
        assert_eq!(continued_view["can_go_back"], true);
        assert!(continued_view["rewind_checkpoint"].is_u64());
        assert_eq!(continued_view["rewind_steps"], 1);
        assert_eq!(expected["view"]["can_go_back"], false);
        assert!(expected["view"]["rewind_checkpoint"].is_null());
        assert_eq!(expected["view"]["rewind_steps"], 0);
        for key in ["can_go_back", "rewind_checkpoint", "rewind_steps"] {
            continued_view[key] = expected["view"][key].clone();
        }
    }
    assert_eq!(continued_view, expected["view"], "all other historical view fields survive recovery");
    drop(golden);
    live.cmds.send(Cmd::Concede { seat: 0 }).unwrap();
    for _ in 0..200 {
        let stage: String =
            sqlx::query_scalar("SELECT stage FROM online_games WHERE game_id='historical-live'").fetch_one(&pool).await.unwrap();
        if stage == "over" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let (stage,version,original):(String,String,String)=sqlx::query_as("SELECT o.stage,g.engine_version,a.replay FROM online_games o JOIN games g ON g.id=o.game_id JOIN online_game_originals a ON a.game_id=g.id WHERE g.id='historical-live'").fetch_one(&pool).await.unwrap();
    assert_eq!(stage, "over");
    assert_eq!(version, identity);
    assert_eq!(original, live_original);
    let (code, body) = request(&app, Method::GET, "/api/play/historical-live/view", Some(&token), None).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["view"]["over"], true);
    // Same executable, wrong bytes: reject before replay parsing, with no database change.
    let dir = tempfile::tempdir().unwrap();
    let bad = dir.path().join("card-data-1e5608e61683de41.json");
    std::fs::write(&bad, "not JSON").unwrap();
    let bad_config = if identity == history::V0119_IDENTITY { history::Config::for_v0119(config.binary, bad) } else { history::Config::new(config.binary, bad) };
    let bad_hub = ready_hub(Some(bad_config));
    saved_game(&pool, "wrong-content", &host, Some(identity), "live", "invalid replay must not be parsed").await;
    let before = saved_bytes(&pool, "wrong-content").await;
    bad_hub.resume_live(&pool).await;
    assert!(bad_hub.live("wrong-content").is_none());
    assert_eq!(saved_bytes(&pool, "wrong-content").await, before);
}

#[tokio::test]
async fn unavailable_runtime_socket_handshake_is_private_and_meaningful() {
    use crate::testutil::user;
    let mut st = crate::testutil::state().await;
    st.play = ready_hub(None);
    let (host, token) = user(&st.pool, "socket-owner@example.com").await;
    let (_, stranger) = user(&st.pool, "socket-stranger@example.com").await;
    saved_game(&st.pool, "socket-old", &host, Some(history::IDENTITY), "live", "invalid").await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = crate::routes::app(st);
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for (token, expected) in [(token, 409), (stranger, 404)] {
        let response = reqwest::Client::new()
            .get(format!("http://{addr}/api/play/socket-old/ws"))
            .bearer_auth(token)
            .header("Connection", "upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), expected);
        if expected == 409 {
            assert!(response.text().await.unwrap().contains("runtime"));
        }
    }
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn original_board_reconnect_preserves_restored_controls_and_explicit_changes() {
    use tokio::io::AsyncReadExt;
    let mut st = crate::testutil::state().await;
    st.play = ready_hub(None);
    let (host, token) = crate::testutil::user(&st.pool, "reconnect-owner@example.com").await;
    let e = engine();
    let mut original = e.new_match_first(5, vec![deck(&[("Island", 99)]), deck(&[("Forest", 99)])], &[], Some(0)).unwrap();
    let saved_stops = Stops { own: ["Upkeep".into()].into(), others: ["End".into()].into() };
    original.set_prefs(0, Some(saved_stops.clone()), true);
    original.set_tap_mana(0, PayMode::Auto);
    let replay = original.replay_json();
    saved_game(&st.pool, "reconnect-controls", &host, Some(yama_play::ENGINE_VERSION), "live", &replay).await;
    save_prefs(&st.pool, &host, &PlayPrefs::default()).await.unwrap();
    st.play.resume_live(&st.pool).await;
    let live = st.play.live("reconnect-controls").unwrap();
    let hub = st.play.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, crate::routes::app(st)).await.unwrap() });

    for connection in 0..3 {
        let response = reqwest::Client::new()
            .get(format!("http://{addr}/api/play/reconnect-controls/ws"))
            .bearer_auth(&token)
            .header("Connection", "upgrade").header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .send().await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::SWITCHING_PROTOCOLS);
        let mut socket = response.upgrade().await.unwrap();
        // The first frame is sent only after watch_game admits connection-time
        // account defaults. A refused move then fences the game-thread queue.
        tokio::time::timeout(Duration::from_secs(5), socket.read_exact(&mut [0u8; 2])).await.unwrap().unwrap();
        assert!(send(&live, |reply| Cmd::Choose { seat: 0, revision: u64::MAX, index: 0, reply }).await.is_err());
        let controls = board(&live, 0).await.turns.unwrap();
        assert_eq!(controls.full_control, connection < 2);
        assert_eq!(controls.tap_mana, if connection < 2 { PayMode::Auto } else { PayMode::Manual });
        assert_eq!(controls.stops, if connection < 2 { Some(saved_stops.clone()) } else { None });
        drop(socket);
        if connection == 1 {
            live.cmds.send(Cmd::Prefs { seat: 0, prefs: PlayPrefs { stops: None, full_control: false, tap_mana: PayMode::Manual } }).unwrap();
        }
    }
    hub.stop("reconnect-controls");
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn wrong_historical_executable_identity_is_unavailable_without_parsing_or_saving() {
    use crate::testutil::{send as request, user};
    use axum::http::{Method, StatusCode};
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let binary = dir.path().join("wrong-runtime");
    let data = dir.path().join("cards.json");
    std::fs::write(&binary, "#!/bin/sh\nprintf '%s\\n' '{\"hello\":{\"identity\":\"wrong\"}}'\n").unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(&data, "invalid data must not be parsed before hello").unwrap();
    let config = history::Config::new(binary, data);
    use sha2::{Digest, Sha256};
    std::fs::write(&config.digest, format!("{}  {}\n", Sha256::digest(std::fs::read(&config.binary).unwrap()).iter().map(|byte| format!("{byte:02x}")).collect::<String>(), config.binary.display())).unwrap();
    assert!(history::Worker::start(&config).err().unwrap().to_string().contains("provenance mismatch"));
    let mut st = crate::testutil::state().await;
    st.play = ready_hub(Some(config));
    let hub = st.play.clone();
    let pool = st.pool.clone();
    let (host, token) = user(&pool, "wrong-runtime@example.com").await;
    for stage in ["live", "over"] {
        saved_game(&pool, stage, &host, Some(history::IDENTITY), stage, "invalid replay").await;
    }
    let before_live = saved_bytes(&pool, "live").await;
    let before_over = saved_bytes(&pool, "over").await;
    hub.resume_live(&pool).await;
    assert_eq!(hub.live_count(), 0);
    let app = crate::routes::app(st);
    for stage in ["live", "over"] {
        let (code, body) = request(&app, Method::GET, &format!("/api/play/{stage}/view"), Some(&token), None).await;
        assert_eq!(code, StatusCode::CONFLICT, "{body}");
    }
    assert_eq!(saved_bytes(&pool, "live").await, before_live);
    assert_eq!(saved_bytes(&pool, "over").await, before_over);
}

#[tokio::test]
async fn current_loader_rejects_wrong_content_before_live_recovery_without_storage_mutation() {
    let pool = crate::db::test_pool().await;
    let (host, _) = crate::testutil::user(&pool, "content-owner@example.com").await;
    saved_game(&pool, "wrong-current-data", &host, Some(yama_play::ENGINE_VERSION), "live", "invalid replay").await;
    let before = saved_bytes(&pool, "wrong-current-data").await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("card-data-cbd552b41f962f5b.json");
    std::fs::write(&path, "invalid data").unwrap();
    let hub = PlayHub::start(Some(path), pool.clone());
    for _ in 0..200 {
        if hub.engine_status().0 == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(hub.engine_status().0, "failed");
    assert!(hub.engine_status().2.unwrap().contains("content mismatch"));
    assert_eq!(hub.live_count(), 0);
    assert_eq!(saved_bytes(&pool, "wrong-current-data").await, before);
}

#[tokio::test]
async fn historical_gameplay_fault_keeps_filtered_board_and_concede_available() {
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::PermissionsExt;
    let st = crate::testutil::state().await;
    let pool = st.pool.clone();
    let (owner, _) = crate::testutil::user(&pool, "paused-history@example.com").await;
    saved_game(
        &pool,
        "paused",
        &owner,
        Some(history::IDENTITY),
        "live",
        "original",
    )
    .await;
    let initial = serde_json::json!({"views":[[null,{"players":[]}],[0,{"players":[],"private":"owner-only"}]],
        "replay":"original","log":[],"answers":[],"revision":0,"over":false,"winner":null,"turn":1,"first":0});
    let mut finished = initial.clone();
    finished["over"] = serde_json::json!(true);
    finished["winner"] = serde_json::json!(1);
    finished["replay"] = serde_json::json!("conceded");
    let hello = serde_json::json!({"hello":serde_json::from_str::<serde_json::Value>(include_str!("../../runtime/historical.json")).unwrap(),
        "source":serde_json::from_str::<serde_json::Value>(include_str!("../../runtime/historical-source.json")).unwrap()});
    let body = format!(
        "#!/bin/sh\nprintf '%s\\n' '{hello}'\nwhile IFS= read -r request; do\ncase \"$request\" in\n*batch*) printf '%s\\n' '{}' ;;\n*preview*) printf '%s\\n' '{{\"sources\":[]}}' ;;\n*concede*) printf '%s\\n' '{}' ;;\n*close*) printf '%s\\n' '{{\"closed\":true}}' ;;\n*) printf '%s\\n' '{}' ;;\nesac\ndone\n",
        serde_json::json!({"state":initial,"moved":0,"settled":true,"fault":"synthetic AI error"}),
        serde_json::json!({"state":finished,"advance":false}),
        serde_json::json!({"state":initial})
    );
    let dir = tempfile::tempdir().unwrap();
    let binary = dir.path().join("worker");
    std::fs::write(&binary, body).unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let config = history::Config::new(binary, dir.path().join("data"));
    std::fs::write(
        &config.digest,
        format!(
            "{}\n",
            Sha256::digest(std::fs::read(&config.binary).unwrap()).iter().map(|byte| format!("{byte:02x}")).collect::<String>()
        ),
    )
    .unwrap();
    let mut worker = history::Worker::start(&config).unwrap();
    let seats = vec![seat(0, "Ana"), seat(1, "Ben")];
    let saved = worker
        .open(&config, "original".into(), None, None, &seats)
        .unwrap();
    let hub = ready_hub(Some(config));
    hub.spawn_historical("paused".into(), worker, saved, HashMap::new(), pool.clone());
    let live = hub.live("paused").unwrap();
    // Preview is queued after the first AI batch and proves the fault retained its receiver.
    let (reply, response) = oneshot::channel();
    live.cmds
        .send(Cmd::Preview {
            seat: 0,
            object: 0,
            reply,
        })
        .unwrap();
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(2), response)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        Vec::<u64>::new()
    );
    let snapshot = live.views.borrow().clone();
    assert_eq!(snapshot.historical_views[&Some(0)]["private"], "owner-only");
    assert!(snapshot.historical_views[&None]["private"].is_null());
    assert!(hub.live("paused").is_some());
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT replay FROM online_games WHERE game_id='paused'")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "original"
    );
    live.cmds.send(Cmd::Concede { seat: 0 }).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let replay: String =
                sqlx::query_scalar("SELECT replay FROM online_games WHERE game_id='paused'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            if replay == "conceded" {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let original: String =
        sqlx::query_scalar("SELECT replay FROM online_game_originals WHERE game_id='paused'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(original, "original");
}

#[tokio::test(flavor = "multi_thread")]
async fn historical_queue_saturation_preserves_other_live_sessions_and_retryable_recovery() {
    use crate::testutil::{send as request, user};
    use axum::http::{Method, StatusCode};
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let started = dir.path().join("started");
    let release = dir.path().join("release");
    let audit = dir.path().join("requests");
    let initial = serde_json::json!({"views":[[null,{"players":[]}],[0,{"players":[],"private":"owner-only"}]],
        "replay":"original","log":[],"answers":[],"revision":0,"over":false,"winner":null,"turn":1,"first":0});
    let mut finished = initial.clone();
    finished["over"] = serde_json::json!(true);
    finished["winner"] = serde_json::json!(1);
    finished["replay"] = serde_json::json!("conceded");
    let hello = serde_json::json!({"hello":serde_json::from_str::<serde_json::Value>(include_str!("../../runtime/historical.json")).unwrap(),
        "source":serde_json::from_str::<serde_json::Value>(include_str!("../../runtime/historical-source.json")).unwrap()});
    let body = format!(
        "#!/bin/sh\nprintf '%s\\n' '{hello}'\nwhile IFS= read -r request; do\nprintf '%s\\n' \"$request\" >> '{audit}'\ncase \"$request\" in\n*hold*) : > '{started}'; while [ ! -e '{release}' ]; do /bin/sleep 0.01; done; printf '%s\\n' '{{\"held\":true}}' ;;\n*queued*) printf '%s\\n' '{{\"queued\":true}}' ;;\n*batch*) printf '%s\\n' '{batch}' ;;\n*preview*) printf '%s\\n' '{{\"sources\":[]}}' ;;\n*view*) printf '%s\\n' '{{\"view\":{{\"players\":[],\"private\":\"owner-only\"}}}}' ;;\n*concede*) printf '%s\\n' '{finished}' ;;\n*close*) printf '%s\\n' '{{\"closed\":true}}' ;;\n*) printf '%s\\n' '{opened}' ;;\nesac\ndone\n",
        audit=audit.display(), started=started.display(), release=release.display(),
        batch=serde_json::json!({"state":initial,"moved":0,"settled":true,"fault":"paused synthetic AI"}),
        finished=serde_json::json!({"state":finished,"advance":false}), opened=serde_json::json!({"state":initial})
    );
    let binary = dir.path().join("worker");
    std::fs::write(&binary, body).unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut config = history::Config::new(binary, dir.path().join("data"));
    config.test_deadlines(Duration::from_secs(5), Duration::from_secs(3));
    std::fs::write(&config.data, "synthetic worker does not load cards").unwrap();
    std::fs::write(&config.digest, format!("{}\n", Sha256::digest(std::fs::read(&config.binary).unwrap()).iter().map(|b| format!("{b:02x}")).collect::<String>())).unwrap();
    let mut st = crate::testutil::state().await;
    let pool = st.pool.clone();
    let (owner, token) = user(&pool, "saturation-owner@example.com").await;
    let (_, stranger) = user(&pool, "saturation-stranger@example.com").await;
    saved_game(&pool, "busy-live", &owner, Some(history::IDENTITY), "live", "original").await;
    saved_game(&pool, "busy-over", &owner, Some(history::IDENTITY), "over", "original").await;
    let live_before = saved_bytes(&pool, "busy-live").await;
    let over_before = saved_bytes(&pool, "busy-over").await;
    // A restart pass competes for this same process without sharing the already
    // active hub's rows. It must retry overload rather than cache unavailability.
    let recovery_pool = crate::db::test_pool().await;
    let (recover_owner, _) = user(&recovery_pool, "recovery-owner@example.com").await;
    saved_game(&recovery_pool, "busy-recover", &recover_owner, Some(history::IDENTITY), "live", "original").await;
    let recovery_before = saved_bytes(&recovery_pool, "busy-recover").await;
    let recovery_hub = ready_hub(Some(config.clone()));
    st.play = ready_hub(Some(config.clone()));
    let hub = st.play.clone();
    let mut live_worker = history::Worker::start(&config).unwrap();
    let seats = vec![seat(0, "Ana"), seat(1, "Ben")];
    let saved = live_worker.open(&config, "original".into(), None, None, &seats).unwrap();
    let pid = live_worker.process_id();
    let mut disposable = history::Worker::start(&config).unwrap();
    disposable.open(&config, "original".into(), None, None, &seats).unwrap();
    let closing_session = disposable.test_session();
    let mut blocker = history::Worker::start(&config).unwrap();
    let blocked = std::thread::spawn(move || blocker.call(serde_json::json!({"op":"hold"})));
    tokio::time::timeout(Duration::from_secs(2), async {
        while !started.exists() { tokio::time::sleep(Duration::from_millis(5)).await; }
    }).await.unwrap();
    let observer = history::Worker::start(&config).unwrap();
    let backlog = observer.test_backlog();
    assert_eq!(backlog.len(), 64, "reach the real production queue capacity");
    // Its first AI batch meets the full queue; the live loop must retain the receiver.
    hub.spawn_historical("busy-live".into(), live_worker, saved, HashMap::new(), pool.clone());
    let live = hub.live("busy-live").unwrap();
    // Drop owes a real close, but its reserved lane must not kill the full shared process.
    drop(disposable);
    let mut failed_open = history::Worker::start(&config).unwrap();
    let failed_session = failed_open.test_session();
    assert!(failed_open.open(&config, "original".into(), None, None, &seats).err().unwrap().is::<history::Busy>());
    drop(failed_open);
    let app = crate::routes::app(st);
    let (code, body) = request(&app, Method::GET, "/api/play/busy-over/view", Some(&token), None).await;
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(body.to_string().contains("retry"));
    assert!(!hub.unavailable.lock().unwrap().contains_key("busy-over"));
    let (code, _) = request(&app, Method::GET, "/api/play/busy-over/view", Some(&stranger), None).await;
    assert_eq!(code, StatusCode::NOT_FOUND);
    let (tx, rx) = oneshot::channel();
    live.cmds.send(Cmd::Preview { seat:0, object:0, reply:tx }).unwrap();
    assert!(rx.await.unwrap().unwrap_err().contains("busy"));
    live.cmds.send(Cmd::Concede { seat:0 }).unwrap(); // fire-and-forget must survive overload too
    assert!(hub.live("busy-live").is_some());
    assert_eq!(live.views.borrow().historical_views[&Some(0)]["private"], "owner-only");
    assert!(live.views.borrow().historical_views[&None]["private"].is_null());
    assert_eq!(saved_bytes(&pool, "busy-live").await, live_before);
    assert_eq!(saved_bytes(&pool, "busy-over").await, over_before);
    assert_eq!(history::Worker::start(&config).unwrap().process_id(), pid);
    let recovery = recovery_hub.resume_live(&recovery_pool);
    tokio::pin!(recovery);
    assert!(tokio::time::timeout(Duration::from_millis(150), &mut recovery).await.is_err(),
        "a saturated restart must wait for retry, not finish by stranding the save");
    assert!(recovery_hub.live("busy-recover").is_none());
    assert!(recovery_hub.unavailable.lock().unwrap().is_empty());
    assert_eq!(saved_bytes(&recovery_pool, "busy-recover").await, recovery_before);
    std::fs::write(&release, "release healthy I/O").unwrap();
    assert!(blocked.join().unwrap().is_ok());
    // Keep the full backlog admitted: disposal must run ahead of it, not wait for capacity.
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let log = std::fs::read_to_string(&audit).unwrap();
            if log.contains(&format!("\"session\":\"{closing_session}\"")) && log.lines().any(|l| l.contains("close") && l.contains(&closing_session)) { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    let log = std::fs::read_to_string(&audit).unwrap();
    let close = log.lines().position(|l| l.contains("close") && l.contains(&closing_session)).unwrap();
    if let Some(queued) = log.lines().position(|l| l.contains("queued")) { assert!(close < queued); }
    assert!(!log.contains(&failed_session), "a rejected open must not execute or enqueue a close");
    drop(backlog);
    tokio::time::timeout(Duration::from_secs(2), &mut recovery).await.unwrap();
    assert!(recovery_hub.live("busy-recover").is_some());
    assert!(recovery_hub.unavailable.lock().unwrap().is_empty());
    assert_eq!(saved_bytes(&recovery_pool, "busy-recover").await, recovery_before);
    let (code, body) = request(&app, Method::GET, "/api/play/busy-over/view", Some(&token), None).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["view"]["private"], "owner-only");
    assert_eq!(saved_bytes(&pool, "busy-over").await, over_before);
    assert_eq!(history::Worker::start(&config).unwrap().process_id(), pid);
    // The concede queued during saturation is retried, not silently discarded.
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let replay: String = sqlx::query_scalar("SELECT replay FROM online_games WHERE game_id='busy-live'").fetch_one(&pool).await.unwrap();
            if replay == "conceded" { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    recovery_hub.live("busy-recover").unwrap().cmds.send(Cmd::Stop).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn historical_deferred_settings_preserve_pending_ai_work() {
    use crate::testutil::user;
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let started = dir.path().join("started");
    let release = dir.path().join("release");
    let audit = dir.path().join("requests");
    let initial = serde_json::json!({"views":[[null,{"players":[]}]],
        "replay":"original","log":[],"answers":[],"revision":0,"over":false,"winner":null,"turn":1,"first":0});
    let mut progressed = initial.clone();
    progressed["replay"] = serde_json::json!("after-ai");
    progressed["revision"] = serde_json::json!(1);
    let hello = serde_json::json!({"hello":serde_json::from_str::<serde_json::Value>(include_str!("../../runtime/historical.json")).unwrap(),
        "source":serde_json::from_str::<serde_json::Value>(include_str!("../../runtime/historical-source.json")).unwrap()});
    let binary = dir.path().join("worker");
    let body = format!(
        "#!/bin/sh\nprintf '%s\\n' '{hello}'\nwhile IFS= read -r request; do\nprintf '%s\\n' \"$request\" >> '{audit}'\ncase \"$request\" in\n*block_queue*) : > '{started}'; while [ ! -e '{release}' ]; do /bin/sleep 0.01; done; printf '%s\\n' '{{\"held\":true}}' ;;\n*queued*) printf '%s\\n' '{{\"queued\":true}}' ;;\n*batch*) printf '%s\\n' '{batch}' ;;\n*preview*) printf '%s\\n' '{{\"sources\":[]}}' ;;\n*close*) printf '%s\\n' '{{\"closed\":true}}' ;;\n*) printf '%s\\n' '{unchanged}' ;;\nesac\ndone\n",
        audit=audit.display(), started=started.display(), release=release.display(),
        batch=serde_json::json!({"state":progressed,"moved":1,"settled":true,"fault":null}),
        unchanged=serde_json::json!({"state":initial,"advance":false}),
    );
    std::fs::write(&binary, body).unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut config = history::Config::new(binary, dir.path().join("data"));
    config.test_deadlines(Duration::from_secs(5), Duration::from_secs(3));
    std::fs::write(&config.data, "synthetic worker does not load cards").unwrap();
    std::fs::write(&config.digest, format!("{}\n", Sha256::digest(std::fs::read(&config.binary).unwrap()).iter().map(|b| format!("{b:02x}")).collect::<String>())).unwrap();
    let pool = crate::db::test_pool().await;
    let (owner, _) = user(&pool, "pending-ai@example.com").await;
    saved_game(&pool, "pending-ai", &owner, Some(history::IDENTITY), "live", "original").await;
    let hub = ready_hub(Some(config.clone()));
    let mut worker = history::Worker::start(&config).unwrap();
    let mut ai = seat(1, "AI");
    ai.kind = "ai".into();
    let saved = worker.open(&config, "original".into(), None, None, &[seat(0, "Ana"), ai]).unwrap();
    let mut blocker = history::Worker::start(&config).unwrap();
    let blocked = std::thread::spawn(move || blocker.call(serde_json::json!({"op":"block_queue"})));
    tokio::time::timeout(Duration::from_secs(2), async {
        while !started.exists() { tokio::time::sleep(Duration::from_millis(5)).await; }
    }).await.unwrap();
    let observer = history::Worker::start(&config).unwrap();
    let backlog = observer.test_backlog();
    assert_eq!(backlog.len(), 64);
    hub.spawn_historical("pending-ai".into(), worker, saved, HashMap::new(), pool.clone());
    let live = hub.live("pending-ai").unwrap();
    live.cmds.send(Cmd::Hold { seat:0, on:false }).unwrap();
    // The preview is a receiver barrier: the batch and settings request have
    // already met Busy, and the settings command is retained for later admission.
    let (tx, rx) = oneshot::channel();
    live.cmds.send(Cmd::Preview { seat:0, object:0, reply:tx }).unwrap();
    assert!(rx.await.unwrap().unwrap_err().contains("busy"));
    std::fs::write(&release, "release healthy I/O").unwrap();
    assert!(blocked.join().unwrap().is_ok());
    drop(backlog);
    // No further player command may be needed to restart the outstanding batch.
    let advanced = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let replay: String = sqlx::query_scalar("SELECT replay FROM online_games WHERE game_id='pending-ai'").fetch_one(&pool).await.unwrap();
            if replay == "after-ai" { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await;
    live.cmds.send(Cmd::Stop).unwrap();
    assert!(advanced.is_ok(), "deferred settings erased the pending AI batch retry");
    let log = std::fs::read_to_string(&audit).unwrap();
    let settings = log.lines().position(|line| line.contains("\"type\":\"hold\"")).unwrap();
    let batch = log.lines().position(|line| line.contains("\"op\":\"batch\"")).unwrap();
    assert!(settings < batch, "the settings command must be admitted before AI resumes");
}

#[tokio::test]
async fn ending_a_solo_game_is_durable_and_does_not_award_a_winner() {
    use crate::testutil::{send as request, user};
    use axum::http::{Method, StatusCode};
    for eliminated in [false, true] {
    let mut st = crate::testutil::state().await;
    let e = Arc::new(engine());
    st.play = Arc::new(PlayHub {
        engine: Mutex::new(EngineState::Ready(e.clone())),
        live: Mutex::new(HashMap::new()),
        historical: None, historical_v0119: None,
        setup_gate: Arc::new(tokio::sync::Semaphore::new(1)),
        unavailable: Mutex::new(HashMap::new()),
    });
    let pool = st.pool.clone();
    let (host, token) = user(&pool, "solo@example.com").await;
    let (_, outsider) = user(&pool, "outside@example.com").await;
    let mut human = seat(0, "Ana");
    human.user_id = Some(host.clone());
    let mut computer = seat(1, "Computer");
    computer.kind = "ai".into();
    computer.user_id = None;
    computer.difficulty = Some("Easy".into());
    let mut other_computer = computer.clone(); other_computer.seat = 2;
    let seats = vec![human, computer, other_computer];
    let mut m = e
        .new_match_first(
            5,
            vec![deck(&[("Mountain", 99)]), deck(&[("Island", 99)]), deck(&[("Forest", 99)])],
            &[(1, Difficulty::Easy), (2, Difficulty::Easy)],
            Some(0),
        )
        .unwrap();
    if eliminated { m.concede(0).unwrap(); }
    sqlx::query("INSERT INTO games (id,mode,created_by,format,status,starting_life,started_at,engine_version) VALUES ('solo-feedback','online',?,'commander','in_progress',40,'2026-11-10T00:00:00Z',?)").bind(&host).bind(yama_play::ENGINE_VERSION).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO online_games (game_id,code,host_id,stage,seats,replay,created_at,updated_at) VALUES ('solo-feedback','SOLOFB',?,'live',?,?,'2026-11-10T00:00:00Z','2026-11-10T00:00:00Z')").bind(&host).bind(serde_json::to_string(&seats).unwrap()).bind(m.replay_json()).execute(&pool).await.unwrap();
    st.play.spawn_game(
        "solo-feedback".into(),
        m,
        seats,
        HashMap::new(),
        pool.clone(),
    );
    let app = crate::routes::app(st);
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/play/solo-feedback/end",
            Some(&outsider),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (status, response) = request(
        &app,
        Method::POST,
        "/api/play/solo-feedback/end",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    let (status, winner): (String, Option<i64>) =
        sqlx::query_as("SELECT status,winner_seat FROM games WHERE id='solo-feedback'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "abandoned");
    assert_eq!(winner, None);
    let (stage, replay): (String, String) =
        sqlx::query_as("SELECT stage,replay FROM online_games WHERE game_id='solo-feedback'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stage, "over");
    assert_eq!(load_row(&pool, "solo-feedback").await.unwrap().status(), "abandoned");
    let restored = e.resume(&replay, &[(1, Difficulty::Easy), (2, Difficulty::Easy)]).unwrap();
    assert!(restored.abandoned() && restored.is_over());
    assert!(restored.winner().is_none());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn solo_rewind_interrupts_ai_progress_and_saves_the_restored_branch() {
    let st = crate::testutil::state().await;
    let pool = st.pool.clone();
    let (host, _) = crate::testutil::user(&pool, "rewind@example.com").await;
    let e = engine();
    let mut seats = vec![seat(0, "You"), seat(1, "Computer"), seat(2, "Computer")];
    seats[0].user_id = Some(host.clone());
    for s in &mut seats[1..] { s.kind = "ai".into(); s.user_id = None; s.difficulty = Some("Easy".into()); }
    let ais = [(1, Difficulty::Easy), (2, Difficulty::Easy)];
    let mut m = e.new_match_first(5, vec![deck(&[("Mountain", 99)]), deck(&[("Island", 99)]), deck(&[("Forest", 99)])], &ais, Some(0)).unwrap();
    let decision = m.decision(0).expect("opening hand");
    let keep = decision.options.iter().find(|o| o.kind == OptionKind::Keep).unwrap().index;
    m.choose(0, decision.revision, keep).unwrap();
    let revision = m.revision;
    let checkpoint = m.view(Some(0)).rewind_checkpoint;
    assert!(checkpoint.is_some());
    // Elimination models the case in which no further human prompt will stop the AI.
    m.concede(0).unwrap();
    assert!(m.revision > revision && !m.is_over());
    sqlx::query("INSERT INTO games (id,mode,created_by,format,status,starting_life,started_at,engine_version) VALUES ('solo-rewind','online',?,'commander','in_progress',40,'2026-11-11T00:00:00Z',?)").bind(&host).bind(yama_play::ENGINE_VERSION).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO online_games (game_id,code,host_id,stage,seats,replay,created_at,updated_at) VALUES ('solo-rewind','REWIND',?,'live',?,?,'2026-11-11T00:00:00Z','2026-11-11T00:00:00Z')").bind(&host).bind(serde_json::to_string(&seats).unwrap()).bind(m.replay_json()).execute(&pool).await.unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let (reply, result) = oneshot::channel();
    tx.send(Cmd::GoBack { seat: 0, revision, checkpoint, reply }).unwrap();
    tx.send(Cmd::Stop).unwrap();
    let (views, mut latest) = watch::channel(Arc::new(Snapshot::default()));
    let (updates, _) = broadcast::channel(16);
    let rt = tokio::runtime::Handle::current();
    let worker_pool = pool.clone();
    let thread = std::thread::Builder::new().stack_size(32 << 20).spawn(move || run_game("solo-rewind", m, &seats, &HashMap::new(), rx, views, updates, &worker_pool, &rt)).unwrap();
    tokio::time::timeout(Duration::from_secs(10), result).await.unwrap().unwrap().unwrap();
    tokio::task::spawn_blocking(move || thread.join().unwrap()).await.unwrap();
    let live = latest.borrow_and_update().clone();
    let view = &live.views[&Some(0)];
    assert!(!view.players[0].eliminated);
    assert!(view.revision > revision);
    assert_eq!(view.rewind_steps, 0, "restoration must not immediately auto-pass the restored choice");
    let replay: String = sqlx::query_scalar("SELECT replay FROM online_games WHERE game_id='solo-rewind'").fetch_one(&pool).await.unwrap();
    let saved: serde_json::Value = serde_json::from_str(&replay).unwrap();
    assert_eq!(saved["yama_rewinds"].as_array().unwrap().len(), 1);
    let resumed = e.resume(&replay, &ais).unwrap();
    assert!(!resumed.view(Some(0)).players[0].eliminated);
    assert_eq!(resumed.revision, view.revision);
    assert_eq!(resumed.view(Some(0)).decision.unwrap().options.iter().filter(|o| o.kind == OptionKind::Keep).count(), 1);
}

#[tokio::test]
async fn a_finished_game_saves_its_knockouts_and_how_it_was_won() {
    let st = crate::testutil::state().await;
    let pool = st.pool.clone();
    let (host, _) = crate::testutil::user(&pool, "results@example.com").await;
    let e = engine();
    let mut m = e.new_match_first(5, vec![deck(&[("Mountain", 99)]), deck(&[("Island", 99)]), deck(&[("Forest", 99)])], &[], Some(0)).unwrap();
    sqlx::query("INSERT INTO games (id,mode,created_by,format,status,starting_life,started_at,engine_version) VALUES ('results','online',?,'commander','in_progress',40,'2026-11-11T00:00:00Z',?)")
        .bind(&host).bind(yama_play::ENGINE_VERSION).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO online_games (game_id,code,host_id,stage,seats,replay,created_at,updated_at) VALUES ('results','RESULT',?,'live','[]',?,'t','t')")
        .bind(&host).bind(m.replay_json()).execute(&pool).await.unwrap();
    for seat in 0..3 {
        sqlx::query("INSERT INTO game_seats (game_id,seat,guest_name) VALUES ('results',?,'Someone')").bind(seat).execute(&pool).await.unwrap();
    }
    let seats = || {
        let pool = pool.clone();
        async move {
            sqlx::query_as::<_, (i64, Option<i64>, Option<i64>)>("SELECT seat, eliminated_turn, eliminated_by_seat FROM game_seats WHERE game_id='results' ORDER BY seat")
                .fetch_all(&pool).await.unwrap()
        }
    };

    // A save that isn't asked for knockouts leaves the seats alone while the game is going.
    m.concede(1).unwrap();
    let turn = i64::from(m.outs()[0].turn);
    assert!(m.events(None).iter().any(|h| matches!(h.what, yama_play::feed::What::Out { seat: 1 }) && i64::from(h.turn) == turn), "the feed has the knockout");
    persist(&pool, "results", &m, false).await.unwrap();
    assert_eq!(seats().await, vec![(0, None, None), (1, None, None), (2, None, None)]);
    persist(&pool, "results", &m, true).await.unwrap();
    assert_eq!(seats().await, vec![(0, None, None), (1, Some(turn), None), (2, None, None)]);

    // Who did it was stored when it happened; a later save that can't name them keeps it, and
    // clears a knockout the game no longer has (a rewind took it back).
    sqlx::query("UPDATE game_seats SET eliminated_by_seat = 0 WHERE game_id='results' AND seat = 1").execute(&pool).await.unwrap();
    sqlx::query("UPDATE game_seats SET eliminated_turn = 9, eliminated_by_seat = 1 WHERE game_id='results' AND seat = 0").execute(&pool).await.unwrap();
    persist(&pool, "results", &m, true).await.unwrap();
    assert_eq!(seats().await, vec![(0, None, None), (1, Some(turn), Some(0)), (2, None, None)]);
    // A different knockout of the same seat doesn't inherit the old one's name.
    sqlx::query("UPDATE game_seats SET eliminated_turn = 99 WHERE game_id='results' AND seat = 1").execute(&pool).await.unwrap();
    persist(&pool, "results", &m, true).await.unwrap();
    assert_eq!(seats().await[1], (1, Some(turn), None));

    // The last opponent concedes: the game is over, and the record says how it was won.
    m.concede(2).unwrap();
    assert!(m.is_over());
    persist(&pool, "results", &m, false).await.unwrap();
    let (status, winner, how): (String, Option<i64>, Option<String>) =
        sqlx::query_as("SELECT status, winner_seat, win_condition FROM games WHERE id='results'").fetch_one(&pool).await.unwrap();
    assert_eq!((status.as_str(), winner, how.as_deref()), ("finished", Some(0), Some("concession")));
    assert_eq!(seats().await, vec![(0, None, None), (1, Some(turn), None), (2, Some(i64::from(m.outs()[1].turn)), None)]);

    // Stats read it like a table game: a decided game with its win condition and a first out.
    let games = crate::stats::finished_games(&pool, crate::stats::Scope::User(&host)).await.unwrap();
    assert_eq!(crate::stats::win_conditions(&games).not_recorded, 0);
    assert_eq!(crate::stats::knockout_games(&games), 1);
}

#[tokio::test]
async fn an_ended_solo_game_has_no_win_condition() {
    let st = crate::testutil::state().await;
    let pool = st.pool.clone();
    let (host, _) = crate::testutil::user(&pool, "ended@example.com").await;
    let e = engine();
    let mut m = e.new_match_first(5, vec![deck(&[("Mountain", 99)]), deck(&[("Island", 99)])], &[(1, Difficulty::Easy)], Some(0)).unwrap();
    sqlx::query("INSERT INTO games (id,mode,created_by,format,status,starting_life,started_at,engine_version) VALUES ('ended','online',?,'commander','in_progress',40,'2026-11-11T00:00:00Z',?)")
        .bind(&host).bind(yama_play::ENGINE_VERSION).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO online_games (game_id,code,host_id,stage,seats,replay,created_at,updated_at) VALUES ('ended','ENDED0',?,'live','[]',?,'t','t')")
        .bind(&host).bind(m.replay_json()).execute(&pool).await.unwrap();
    m.concede(0).unwrap();
    m.abandon();
    persist(&pool, "ended", &m, true).await.unwrap();
    let (status, winner, how): (String, Option<i64>, Option<String>) =
        sqlx::query_as("SELECT status, winner_seat, win_condition FROM games WHERE id='ended'").fetch_one(&pool).await.unwrap();
    assert_eq!((status.as_str(), winner, how), ("abandoned", None, None));
}

#[tokio::test]
async fn people_in_the_games_playgroup_are_seated_as_its_members() {
    use crate::testutil::{deck as make_deck, user};
    let mut st = crate::testutil::state().await;
    st.play = ready_hub(None);
    let pool = st.pool.clone();
    let (host, _) = user(&pool, "member-host@example.com").await;
    let (friend, _) = user(&pool, "member-friend@example.com").await;
    let (host_deck, host_version) = make_deck(&pool, &host, "Host").await;
    let (friend_deck, friend_version) = make_deck(&pool, &friend, "Friend").await;
    let cards = vec![
        crate::decks::DeckCard { oracle_id: "commander".into(), name: "Combat Celebrant".into(), qty: 1, board: crate::decks::Board::Commander },
        crate::decks::DeckCard { oracle_id: "land".into(), name: "Island".into(), qty: 99, board: crate::decks::Board::Main },
    ];
    for version in [&host_version, &friend_version] {
        sqlx::query("UPDATE deck_versions SET cards=? WHERE id=?").bind(serde_json::to_string(&cards).unwrap()).bind(version).execute(&pool).await.unwrap();
    }
    // The host is in the game's playgroup; the friend who joined by code isn't. Another group's
    // member row for the friend must not be picked up.
    for (group, member, user) in [("pg-game", "m-host", &host), ("pg-other", "m-friend-elsewhere", &friend)] {
        sqlx::query("INSERT OR IGNORE INTO playgroups (id,name,owner_id,join_code,created_at) VALUES (?,?,?,?,'t')")
            .bind(group).bind(group).bind(&host).bind(group.to_uppercase()).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO playgroup_members (id,playgroup_id,user_id,created_at) VALUES (?,?,?,'t')")
            .bind(member).bind(group).bind(user).execute(&pool).await.unwrap();
    }
    let seats: Vec<_> = [(&host, &host_deck, &host_version), (&friend, &friend_deck, &friend_version)]
        .into_iter().enumerate().map(|(n, (user, deck, version))| {
            let mut s = seat(n as u8, "Player");
            s.user_id = Some(user.to_string());
            s.deck_id = Some(deck.to_string());
            s.deck_version_id = Some(version.to_string());
            s
        }).collect();
    sqlx::query("INSERT INTO games(id,mode,created_by,status,started_at,playgroup_id) VALUES('members','online',?,'in_progress','2026-11-11T00:00:00Z','pg-game')")
        .bind(&host).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO online_games(game_id,code,host_id,stage,seats,created_at,updated_at) VALUES('members','MEMBER',?,'lobby',?,'t','t')")
        .bind(&host).bind(serde_json::to_string(&seats).unwrap()).execute(&pool).await.unwrap();
    start_game(&st, "members", &host).await.unwrap();
    let stored: Vec<(i64, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT seat, member_id, user_id FROM game_seats WHERE game_id='members' ORDER BY seat").fetch_all(&pool).await.unwrap();
    assert_eq!(stored, vec![(0, Some("m-host".into()), Some(host.clone())), (1, None, Some(friend.clone()))]);
    st.play.stop("members");
}

/// 13 Nov 2026: a phone gave up on a slow start and the table was left in its lobby. A start whose
/// request goes away still puts the game live.
#[tokio::test]
async fn a_start_whose_request_disconnects_still_goes_live() {
    use crate::testutil::{deck as make_deck, user};
    let mut st = crate::testutil::state().await;
    st.play = ready_hub(None);
    let pool = st.pool.clone();
    let (host, _) = user(&pool, "gone-host@example.com").await;
    let (friend, _) = user(&pool, "gone-friend@example.com").await;
    let (host_deck, host_version) = make_deck(&pool, &host, "Host").await;
    let (friend_deck, friend_version) = make_deck(&pool, &friend, "Friend").await;
    let cards = vec![
        crate::decks::DeckCard { oracle_id: "commander".into(), name: "Combat Celebrant".into(), qty: 1, board: crate::decks::Board::Commander },
        crate::decks::DeckCard { oracle_id: "land".into(), name: "Island".into(), qty: 99, board: crate::decks::Board::Main },
    ];
    for version in [&host_version, &friend_version] {
        sqlx::query("UPDATE deck_versions SET cards=? WHERE id=?").bind(serde_json::to_string(&cards).unwrap()).bind(version).execute(&pool).await.unwrap();
    }
    let seats: Vec<_> = [(&host, &host_deck, &host_version), (&friend, &friend_deck, &friend_version)]
        .into_iter().enumerate().map(|(n, (user, deck, version))| {
            let mut s = seat(n as u8, "Player");
            s.user_id = Some(user.to_string());
            s.deck_id = Some(deck.to_string());
            s.deck_version_id = Some(version.to_string());
            s
        }).collect();
    sqlx::query("INSERT INTO games(id,mode,created_by,status,started_at) VALUES('gone','online',?,'in_progress','2026-11-13T00:00:00Z')")
        .bind(&host).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO online_games(game_id,code,host_id,stage,seats,created_at,updated_at) VALUES('gone','GONE00',?,'lobby',?,'t','t')")
        .bind(&host).bind(serde_json::to_string(&seats).unwrap()).execute(&pool).await.unwrap();
    // Another start holds the setup slot, so this one is certainly still waiting when its
    // request goes away.
    let busy = st.play.setup_gate.clone().acquire_owned().await.unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(50), start_detached(&st, "gone", &host)).await.is_err());
    assert_eq!(load_row(&pool, "gone").await.unwrap().stage, "lobby");
    drop(busy);
    let live = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if load_row(&pool, "gone").await.unwrap().stage == "live" && st.play.live("gone").is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(live.is_ok(), "the start went on after its request disconnected");
    st.play.stop("gone");
}

#[tokio::test]
async fn the_member_backfill_fills_only_online_seats_whose_account_is_in_the_games_group() {
    let pool = crate::db::test_pool().await;
    for id in ["ana", "ben"] {
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES (?,?,?,'t')").bind(id).bind(format!("{id}@x.y")).bind(id).execute(&pool).await.unwrap();
    }
    for group in ["pg", "other"] {
        sqlx::query("INSERT INTO playgroups (id,name,owner_id,join_code,created_at) VALUES (?,?,'ana',?,'t')").bind(group).bind(group).bind(group.to_uppercase()).execute(&pool).await.unwrap();
    }
    for (member, group, user, guest) in [("m-ana", "pg", Some("ana"), None), ("m-ben-other", "other", Some("ben"), None), ("m-guest", "pg", None, Some("Kelly"))] {
        sqlx::query("INSERT INTO playgroup_members (id,playgroup_id,user_id,guest_name,created_at) VALUES (?,?,?,?,'t')")
            .bind(member).bind(group).bind(user).bind(guest).execute(&pool).await.unwrap();
    }
    for (game, mode, group) in [("online", "online", Some("pg")), ("no-group", "online", None), ("table", "in_person", Some("pg"))] {
        sqlx::query("INSERT INTO games (id,mode,created_by,status,started_at,playgroup_id) VALUES (?,?,'ana','finished','t',?)").bind(game).bind(mode).bind(group).execute(&pool).await.unwrap();
        // Ana is in "pg"; Ben only in another group; the computer has no account.
        for (seat, user, ai) in [(0, Some("ana"), None), (1, Some("ben"), None), (2, None, Some("phase-ai Easy"))] {
            sqlx::query("INSERT INTO game_seats (game_id,seat,user_id,ai_kind) VALUES (?,?,?,?)").bind(game).bind(seat).bind(user).bind(ai).execute(&pool).await.unwrap();
        }
    }
    sqlx::raw_sql(include_str!("../migrations/0074_online_seat_members.sql")).execute(&pool).await.unwrap();
    let filled: Vec<(String, i64, String)> =
        sqlx::query_as("SELECT game_id, seat, member_id FROM game_seats WHERE member_id IS NOT NULL ORDER BY game_id, seat").fetch_all(&pool).await.unwrap();
    assert_eq!(filled, vec![("online".to_string(), 0, "m-ana".to_string())]);
}

#[tokio::test]
async fn a_knockout_the_feed_has_let_go_keeps_what_was_stored_when_it_happened() {
    use results::Knockout;
    let pool = crate::db::test_pool().await;
    sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('ana','ana@x.y','Ana','t')").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO games (id,mode,created_by,status,started_at) VALUES ('long','online','ana','in_progress','t')").execute(&pool).await.unwrap();
    for seat in 0..4 {
        sqlx::query("INSERT INTO game_seats (game_id,seat,guest_name) VALUES ('long',?,'Someone')").bind(seat).execute(&pool).await.unwrap();
    }
    let seats = || {
        let pool = pool.clone();
        async move {
            sqlx::query_as::<_, (i64, Option<i64>, Option<i64>)>("SELECT seat, eliminated_turn, eliminated_by_seat FROM game_seats WHERE game_id='long' ORDER BY seat")
                .fetch_all(&pool).await.unwrap()
        }
    };
    let write = |found: Vec<Knockout>| {
        let pool = pool.clone();
        async move {
            let mut tx = pool.begin().await.unwrap();
            write_knockouts(&mut tx, "long", &found).await.unwrap();
            tx.commit().await.unwrap();
        }
    };
    // Seat 1 goes out on turn 5 to seat 0's attack, while the feed holds it.
    write(vec![Knockout { seat: 1, turn: 5, by: Some(0), seen: true }]).await;
    assert_eq!(seats().await[1], (1, Some(5), Some(0)));
    // Much later seat 2 goes out. The feed has dropped seat 1's knockout: all that's left of it
    // is the engine's turn after that action (6) and nobody to name. What was stored stands.
    write(vec![Knockout { seat: 1, turn: 6, by: None, seen: false }, Knockout { seat: 2, turn: 40, by: None, seen: true }]).await;
    assert_eq!(seats().await, vec![(0, None, None), (1, Some(5), Some(0)), (2, Some(40), None), (3, None, None)]);
    // The feed still has the knockout but no longer the hit behind it: the name stays.
    write(vec![Knockout { seat: 1, turn: 5, by: None, seen: true }, Knockout { seat: 2, turn: 40, by: None, seen: true }]).await;
    assert_eq!(seats().await[1], (1, Some(5), Some(0)));
    // A knockout never stored (the server restarted before its save) takes what's left to tell.
    write(vec![Knockout { seat: 1, turn: 5, by: None, seen: false }, Knockout { seat: 2, turn: 40, by: None, seen: false }, Knockout { seat: 3, turn: 44, by: None, seen: false }]).await;
    assert_eq!(seats().await[3], (3, Some(44), None));
    // A rewind took every knockout back.
    write(vec![]).await;
    assert_eq!(seats().await, vec![(0, None, None), (1, None, None), (2, None, None), (3, None, None)]);
}

#[tokio::test]
async fn the_host_cancels_a_waiting_table_and_deletes_a_finished_game() {
    use crate::testutil::{send as request, user};
    use axum::http::{Method, StatusCode};
    let mut st = crate::testutil::state().await;
    st.play = ready_hub(None);
    let pool = st.pool.clone();
    let app = crate::routes::app(st);
    let (host, host_token) = user(&pool, "cancel-host@example.com").await;
    let (friend, friend_token) = user(&pool, "cancel-friend@example.com").await;
    let (_, stranger_token) = user(&pool, "cancel-stranger@example.com").await;
    let mut seats = vec![seat(0, "Host"), seat(1, "Friend")];
    seats[0].user_id = Some(host.clone());
    seats[1].user_id = Some(friend.clone());
    for (id, stage, status) in [("waiting", "lobby", "in_progress"), ("playing", "live", "in_progress"), ("done", "over", "finished")] {
        sqlx::query("INSERT INTO games (id,mode,created_by,format,status,starting_life,started_at,engine_version) VALUES (?,'online',?,'commander',?,40,'2026-11-11T00:00:00Z',?)")
            .bind(id).bind(&host).bind(status).bind(yama_play::ENGINE_VERSION).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO online_games (game_id,code,host_id,stage,seats,created_at,updated_at) VALUES (?,?,?,?,?,'t','t')")
            .bind(id).bind(id.to_uppercase()).bind(&host).bind(stage).bind(serde_json::to_string(&seats).unwrap()).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO game_seats (game_id,seat,user_id) VALUES (?,0,?)").bind(id).bind(&host).execute(&pool).await.unwrap();
    }
    sqlx::query("UPDATE online_games SET rematch_id = 'waiting' WHERE game_id = 'done'").execute(&pool).await.unwrap();
    let delete = |id: &'static str, token: &str| {
        let (app, token) = (app.clone(), token.to_string());
        async move { request(&app, Method::DELETE, &format!("/api/play/{id}"), Some(&token), None).await }
    };
    // Someone outside the game learns nothing, and a seated friend may not.
    assert_eq!(delete("waiting", &stranger_token).await.0, StatusCode::NOT_FOUND);
    for id in ["waiting", "done"] {
        assert_eq!(delete(id, &friend_token).await.0, StatusCode::FORBIDDEN);
    }
    // A game being played stays.
    let (status, body) = delete("playing", &host_token).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    // The host cancels the table: the game row, its lobby and seats go, and the finished game's
    // pointer to it as a rematch.
    let (status, body) = delete("waiting", &host_token).await;
    assert_eq!((status, body["was"].as_str()), (StatusCode::OK, Some("lobby")), "{body}");
    let left: Vec<String> = sqlx::query_scalar("SELECT id FROM games ORDER BY id").fetch_all(&pool).await.unwrap();
    assert_eq!(left, ["done", "playing"]);
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM online_games WHERE game_id = 'waiting'").fetch_one(&pool).await.unwrap(), 0);
    assert_eq!(sqlx::query_scalar::<_, Option<String>>("SELECT rematch_id FROM online_games WHERE game_id = 'done'").fetch_one(&pool).await.unwrap(), None);
    // ...and deletes the finished game, for everyone who played.
    let (status, body) = delete("done", &host_token).await;
    assert_eq!((status, body["was"].as_str()), (StatusCode::OK, Some("game")), "{body}");
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM game_seats WHERE game_id = 'done'").fetch_one(&pool).await.unwrap(), 0);
    assert_eq!(delete("done", &host_token).await.0, StatusCode::NOT_FOUND);
    // The game that was being played is untouched.
    assert_eq!(load_row(&pool, "playing").await.unwrap().stage, "live");
}

/// Matt, 11 Nov 2026: two games left live on a retired engine build filled his open-game
/// allowance, and they could neither be played, ended nor deleted, so he couldn't start a game.
#[tokio::test]
async fn games_stranded_on_a_retired_runtime_free_their_place_and_can_be_deleted() {
    use crate::testutil::{send as request, user};
    use axum::http::{Method, StatusCode};
    let mut st = crate::testutil::state().await;
    st.play = ready_hub(None);
    let hub = st.play.clone();
    let pool = st.pool.clone();
    let (host, token) = user(&pool, "stranded@example.com").await;
    let (_, stranger) = user(&pool, "stranded-stranger@example.com").await;
    let user_row = crate::auth::User { id: host.clone(), email: "stranded@example.com".into(), display_name: "Matt".into(), is_admin: false, limited: true, power: false, guest: false };
    // Live, on a runtime this server doesn't have, and never recovered (no thread).
    saved_game(&pool, "stranded-a", &host, Some("phase-v0.113.0+0571ee32-yama1/cards-eb309108"), "live", "{}").await;
    saved_game(&pool, "stranded-b", &host, None, "live", "{}").await;
    // With the current engine down at startup they can't be moved over or closed yet: stranded.
    *hub.engine.lock().unwrap() = EngineState::Failed("deliberately down in the stranded-games test".into());
    hub.resume_live(&pool).await;
    check_open_games(&pool, &user_row).await.expect("stranded games don't hold places");
    // Runnable games still count: three current-runtime tables fill the standard allowance.
    saved_game(&pool, "open-a", &host, Some(yama_play::ENGINE_VERSION), "lobby", "{}").await;
    saved_game(&pool, "open-b", &host, Some(yama_play::ENGINE_VERSION), "lobby", "{}").await;
    check_open_games(&pool, &user_row).await.expect("two open games leave room for a third");
    saved_game(&pool, "open-c", &host, Some(yama_play::ENGINE_VERSION), "lobby", "{}").await;
    assert!(check_open_games(&pool, &user_row).await.is_err());
    // Games only waiting for their engine are not stranded: the historical runtime isn't
    // installed here, and the current engine has failed. Both come back once fixed.
    saved_game(&pool, "waiting-historical", &host, Some(history::IDENTITY), "live", "{}").await;
    saved_game(&pool, "waiting-v0119", &host, Some(history::V0119_IDENTITY), "live", "{}").await;
    saved_game(&pool, "waiting-current", &host, Some(yama_play::ENGINE_VERSION), "live", "{}").await;
    let app = crate::routes::app(st);
    for id in ["waiting-historical", "waiting-v0119", "waiting-current"] {
        let (_, detail) = request(&app, Method::GET, &format!("/api/play/{id}"), Some(&token), None).await;
        assert!(detail["runtime_error"].is_string(), "{detail}");
        assert_eq!(detail.get("stranded"), None, "{detail}");
        let (code, body) = request(&app, Method::DELETE, &format!("/api/play/{id}"), Some(&token), None).await;
        assert_eq!(code, StatusCode::CONFLICT, "{body}");
    }
    let (code, _) = request(&app, Method::DELETE, "/api/play/stranded-a", Some(&stranger), None).await;
    assert_eq!(code, StatusCode::NOT_FOUND);
    let (_, detail) = request(&app, Method::GET, "/api/play/stranded-a", Some(&token), None).await;
    assert_eq!(detail["stranded"], true, "{detail}");
    for id in ["stranded-a", "stranded-b"] {
        let (code, body) = request(&app, Method::DELETE, &format!("/api/play/{id}"), Some(&token), None).await;
        assert_eq!((code, body["was"].as_str()), (StatusCode::OK, Some("game")), "{body}");
    }
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games WHERE id LIKE 'stranded-%'").fetch_one(&pool).await.unwrap();
    assert_eq!(left, 0);
}

/// The new current pin must not make retained v0.119 tables appear retired.
#[tokio::test]
async fn retained_v0119_games_still_hold_open_game_places() {
    use crate::testutil::user;
    let pool = crate::db::test_pool().await;
    let (host, _) = user(&pool, "retained-v0119@example.com").await;
    let user_row = crate::auth::User { id: host.clone(), email: "retained-v0119@example.com".into(), display_name: "Ana".into(), is_admin: false, limited: true, power: false, guest: false };
    for n in 0..OPEN_MAX_OPEN_GAMES {
        check_open_games(&pool, &user_row).await.expect("room remains below the configured allowance");
        saved_game(&pool, &format!("retained-{n}"), &host, Some(history::V0119_IDENTITY), "live", "{}").await;
    }
    assert!(!is_retired_runtime(Some(history::V0119_IDENTITY)));
    // A ready current engine must not reinterpret or close a recognized saved
    // game just because its preserved worker is temporarily unavailable.
    ready_hub(None).resume_live(&pool).await;
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT g.engine_version,o.stage FROM games g JOIN online_games o ON o.game_id=g.id WHERE g.id LIKE 'retained-%'")
        .fetch_all(&pool).await.unwrap();
    assert_eq!(rows.len() as i64, OPEN_MAX_OPEN_GAMES);
    assert!(rows.iter().all(|(identity, stage)| identity == history::V0119_IDENTITY && stage == "live"));
    assert!(check_open_games(&pool, &user_row).await.is_err(), "preserved games count even while their worker is unavailable");
}

#[test]
fn the_limit_message_names_what_is_open_the_limit_and_how_to_close_it() {
    assert_eq!(open_games_message(1, 0, 1), "You have 1 table waiting for players, and the limit is 1 open game at a time. Close it from its page before opening another.");
    assert_eq!(open_games_message(3, 0, 3), "You have 3 tables waiting for players, and the limit is 3 open games at a time. Close one from its page before opening another.");
    assert_eq!(open_games_message(0, 1, 1), "You have 1 game being played, and the limit is 1 open game at a time. Finish it before starting another.");
    assert_eq!(open_games_message(0, 3, 3), "You have 3 games being played, and the limit is 3 open games at a time. Finish one before starting another.");
    assert_eq!(
        open_games_message(1, 2, 3),
        "You have 1 table waiting for players and 2 games being played, and the limit is 3 open games at a time. Close a waiting table from its page, or finish a game, before starting another."
    );
}

#[tokio::test]
async fn a_seated_player_answers_the_end_of_game_questions() {
    use crate::testutil::{send as request, user};
    use axum::http::{Method, StatusCode};
    let mut st = crate::testutil::state().await;
    st.play = ready_hub(None);
    let pool = st.pool.clone();
    let app = crate::routes::app(st);
    let (host, host_token) = user(&pool, "result-host@example.com").await;
    let (friend, friend_token) = user(&pool, "result-friend@example.com").await;
    let (watcher, watcher_token) = user(&pool, "result-watcher@example.com").await;
    let (_, stranger_token) = user(&pool, "result-stranger@example.com").await;
    // The watcher is in the game's playgroup, so may see the game, but didn't play in it.
    sqlx::query("INSERT INTO playgroups (id,name,owner_id,join_code,created_at) VALUES ('pg-result','Group',?,'RESULT','t')").bind(&host).execute(&pool).await.unwrap();
    for (member, account) in [("m-result-host", &host), ("m-result-watcher", &watcher)] {
        sqlx::query("INSERT INTO playgroup_members (id,playgroup_id,user_id,created_at) VALUES (?,'pg-result',?,'t')").bind(member).bind(account).execute(&pool).await.unwrap();
    }
    let mut seats = vec![seat(0, "Host"), seat(1, "Friend"), seat(2, "Computer")];
    seats[0].user_id = Some(host.clone());
    seats[1].user_id = Some(friend.clone());
    seats[2].kind = "ai".into();
    seats[2].user_id = None;
    for (id, stage, status, winner, how) in [
        ("won", "over", "finished", Some(1), Some("combat")),
        ("drawn", "over", "finished", None, None),
        ("going", "live", "in_progress", None, None),
        ("ended", "over", "abandoned", None, None),
    ] {
        sqlx::query("INSERT INTO games (id,mode,created_by,format,status,starting_life,started_at,playgroup_id,winner_seat,win_condition) VALUES (?,'online',?,'commander',?,40,'2026-11-11T00:00:00Z','pg-result',?,?)")
            .bind(id).bind(&host).bind(status).bind(winner).bind(how).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO online_games (game_id,code,host_id,stage,seats,created_at,updated_at) VALUES (?,?,?,?,?,'t','t')")
            .bind(id).bind(id.to_uppercase()).bind(&host).bind(stage).bind(serde_json::to_string(&seats).unwrap()).execute(&pool).await.unwrap();
        for (n, account, ai) in [(0, Some(&host), None), (1, Some(&friend), None), (2, None, Some("phase-ai Medium"))] {
            sqlx::query("INSERT INTO game_seats (game_id,seat,user_id,ai_kind) VALUES (?,?,?,?)").bind(id).bind(n).bind(account).bind(ai).execute(&pool).await.unwrap();
        }
    }
    let post = |id: &'static str, token: &str, body: serde_json::Value| {
        let (app, token) = (app.clone(), token.to_string());
        async move { request(&app, Method::POST, &format!("/api/play/{id}/result"), Some(&token), Some(body)).await }
    };
    let stored = |id: &'static str| {
        let pool = pool.clone();
        async move {
            let how: Option<String> = sqlx::query_scalar("SELECT win_condition FROM games WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap();
            let fun: Vec<Option<i64>> = sqlx::query_scalar("SELECT fun FROM game_seats WHERE game_id = ? ORDER BY seat").bind(id).fetch_all(&pool).await.unwrap();
            (how, fun)
        }
    };
    let answer = serde_json::json!({ "win_condition": "combo", "fun": 4 });

    // Someone outside the game learns nothing; someone who can see it but didn't play may not answer.
    assert_eq!(post("won", &stranger_token, answer.clone()).await.0, StatusCode::NOT_FOUND);
    assert_eq!(post("won", &watcher_token, answer.clone()).await.0, StatusCode::FORBIDDEN);
    // Only a game with a result: not one being played, nor one ended without a winner.
    for id in ["going", "ended"] {
        assert_eq!(post(id, &friend_token, answer.clone()).await.0, StatusCode::CONFLICT, "{id}");
    }
    for bad in [serde_json::json!({ "win_condition": "vibes" }), serde_json::json!({ "fun": 0 }), serde_json::json!({ "fun": 6 })] {
        assert_eq!(post("won", &friend_token, bad.clone()).await.0, StatusCode::BAD_REQUEST, "{bad}");
    }
    assert_eq!(stored("won").await, (Some("combat".into()), vec![None, None, None]), "nothing refused was stored");

    // The game-over screen starts from what the engine read.
    let (_, game) = request(&app, Method::GET, "/api/play/won", Some(&friend_token), None).await;
    assert_eq!((&game["win_condition"], &game["fun"]), (&serde_json::json!("combat"), &serde_json::Value::Null));

    // The engine recorded "combat". Another player can't change or clear what's recorded (and
    // nothing else in that request is saved); agreeing with it is fine, with their own rating.
    for other in [serde_json::json!({ "win_condition": "combo", "fun": 4 }), serde_json::json!({ "win_condition": null })] {
        assert_eq!(post("won", &friend_token, other.clone()).await.0, StatusCode::FORBIDDEN, "{other}");
    }
    assert_eq!(stored("won").await, (Some("combat".into()), vec![None, None, None]));
    let (status, saved) = post("won", &friend_token, serde_json::json!({ "win_condition": "combat", "fun": 4 })).await;
    assert_eq!((status, &saved["win_condition"], &saved["fun"]), (StatusCode::OK, &serde_json::json!("combat"), &serde_json::json!(4)), "{saved}");
    // The host corrects it, as whoever records a table game writes its finish. A field left out
    // stays as it is; null clears it. Nobody else's rating moves.
    assert_eq!(post("won", &host_token, serde_json::json!({ "win_condition": "combo", "fun": 2 })).await.0, StatusCode::OK);
    assert_eq!(stored("won").await, (Some("combo".into()), vec![Some(2), Some(4), None]));
    assert_eq!(post("won", &friend_token, serde_json::json!({ "fun": null })).await.0, StatusCode::OK);
    assert_eq!(post("won", &host_token, serde_json::json!({ "win_condition": null })).await.0, StatusCode::OK);
    assert_eq!(stored("won").await, (None, vec![Some(2), None, None]));
    // With nothing recorded, any player may say how it was won; then it's recorded again.
    assert_eq!(post("won", &friend_token, serde_json::json!({ "win_condition": "poison" })).await.0, StatusCode::OK);
    assert_eq!(post("won", &friend_token, serde_json::json!({ "win_condition": "mill" })).await.0, StatusCode::FORBIDDEN);
    assert_eq!(post("won", &host_token, serde_json::json!({ "win_condition": null })).await.0, StatusCode::OK);
    assert_eq!(stored("won").await, (None, vec![Some(2), None, None]));
    // A rating that has no seat to land on is refused, not reported as saved.
    sqlx::query("UPDATE game_seats SET user_id = NULL, guest_name = 'Former player' WHERE game_id = 'drawn' AND seat = 0").execute(&pool).await.unwrap();
    assert_eq!(post("drawn", &host_token, serde_json::json!({ "fun": 3 })).await.0, StatusCode::CONFLICT);
    let (_, game) = request(&app, Method::GET, "/api/play/won", Some(&host_token), None).await;
    assert_eq!((&game["win_condition"], &game["fun"]), (&serde_json::Value::Null, &serde_json::json!(2)));

    // The host writes the game's note; another player may not, and an empty note is no note.
    assert_eq!(post("won", &friend_token, serde_json::json!({ "note": "Mine" })).await.0, StatusCode::FORBIDDEN);
    assert_eq!(post("won", &host_token, serde_json::json!({ "note": "x".repeat(1001) })).await.0, StatusCode::BAD_REQUEST);
    let (status, saved) = post("won", &host_token, serde_json::json!({ "note": "  Ben's first online game  " })).await;
    assert_eq!((status, &saved["note"], &saved["fun"]), (StatusCode::OK, &serde_json::json!("Ben's first online game"), &serde_json::json!(2)), "{saved}");
    let (_, game) = request(&app, Method::GET, "/api/play/won", Some(&friend_token), None).await;
    assert_eq!(game["note"], "Ben's first online game");
    assert_eq!(post("won", &host_token, serde_json::json!({ "note": "   " })).await.0, StatusCode::OK);
    assert_eq!(sqlx::query_scalar::<_, Option<String>>("SELECT note FROM games WHERE id = 'won'").fetch_one(&pool).await.unwrap(), None);

    // A draw can be rated, but nobody won it any particular way.
    assert_eq!(post("drawn", &friend_token, serde_json::json!({ "win_condition": "combat" })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(post("drawn", &friend_token, serde_json::json!({ "fun": 5 })).await.0, StatusCode::OK);
    assert_eq!(stored("drawn").await, (None, vec![None, Some(5), None]));
}

#[tokio::test]
async fn the_host_chooses_who_goes_first_and_seats_a_precon_for_the_computer() {
    use crate::testutil::{deck as make_deck, send as request, user};
    use axum::http::{Method, StatusCode};
    let mut st = crate::testutil::state().await;
    st.play = ready_hub(None);
    let hub = st.play.clone();
    let pool = st.pool.clone();
    let app = crate::routes::app(st);
    let (host, token) = user(&pool, "setup-host@example.com").await;
    let (deck_id, version) = make_deck(&pool, &host, "Host's deck").await;
    let cards = vec![
        crate::decks::DeckCard { oracle_id: "commander".into(), name: "Combat Celebrant".into(), qty: 1, board: crate::decks::Board::Commander },
        crate::decks::DeckCard { oracle_id: "land".into(), name: "Island".into(), qty: 99, board: crate::decks::Board::Main },
    ];
    sqlx::query("UPDATE deck_versions SET cards=? WHERE id=?").bind(serde_json::to_string(&cards).unwrap()).bind(&version).execute(&pool).await.unwrap();
    // A stock precon the engine's small card fixture can play.
    let stock = vec![
        crate::lab::PreconCard { name: "Combat Celebrant".into(), oracle_id: None, qty: 1, board: crate::decks::Board::Commander },
        crate::lab::PreconCard { name: "Mountain".into(), oracle_id: None, qty: 99, board: crate::decks::Board::Main },
    ];
    sqlx::query("INSERT INTO precons (id, lab_id, name, set_code, commanders, color_identity, cards, source, content_sha256, imported_at) VALUES ('test-precon','precons/test-precon','Test Precon','TST','[\"Combat Celebrant\"]','R',?,'fixture','hash','2026-11-11')")
        .bind(serde_json::to_string(&stock).unwrap()).execute(&pool).await.unwrap();

    let seats = serde_json::json!([
        { "kind": "me", "deck_id": deck_id },
        { "kind": "ai", "precon_id": "test-precon", "difficulty": "Easy" },
        { "kind": "ai", "deck_id": deck_id, "difficulty": "Easy" },
    ]);
    // The first player must be a seat, and the precon must exist.
    let (status, _) = request(&app, Method::POST, "/api/play", Some(&token), Some(serde_json::json!({ "seats": seats, "first": 3 }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let mut unknown = seats.clone();
    unknown[1]["precon_id"] = serde_json::json!("no-such-precon");
    let (status, _) = request(&app, Method::POST, "/api/play", Some(&token), Some(serde_json::json!({ "seats": unknown }))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Seat 2 (the precon) goes first. No friend to wait for, so the game starts at once.
    let (status, made) = request(&app, Method::POST, "/api/play", Some(&token), Some(serde_json::json!({ "seats": seats, "first": 1 }))).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    let id = made["id"].as_str().unwrap().to_string();
    let r = load_row(&pool, &id).await.unwrap();
    assert_eq!(r.stage, "live");
    // The table is numbered from the first player, in the same order round the table.
    let now = r.seats();
    assert_eq!(now.iter().map(|s| s.seat).collect::<Vec<_>>(), vec![0, 1, 2]);
    assert_eq!((now[0].kind.as_str(), now[0].deck_id.as_deref(), now[0].deck_version_id.as_deref(), now[0].deck_name.as_deref()), ("ai", Some("precon:test-precon"), None, Some("Test Precon")));
    assert_eq!((now[1].kind.as_str(), now[1].deck_id.as_deref()), ("ai", Some(deck_id.as_str())));
    assert_eq!((now[2].kind.as_str(), now[2].user_id.as_deref()), ("human", Some(host.as_str())));
    let (first_seat, replay): (Option<i64>, String) =
        sqlx::query_as("SELECT g.first_seat, o.replay FROM games g JOIN online_games o ON o.game_id = g.id WHERE g.id = ?").bind(&id).fetch_one(&pool).await.unwrap();
    let replay: serde_json::Value = serde_json::from_str(&replay).unwrap();
    assert_eq!((first_seat, replay["header"]["first_player"].as_u64()), (Some(0), Some(0)));
    // The precon's seat is on the game record without a deck version: it's on no deck's record.
    let stored: Vec<(i64, Option<String>, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT seat, user_id, ai_kind, deck_version_id, deck_label FROM game_seats WHERE game_id = ? ORDER BY seat").bind(&id).fetch_all(&pool).await.unwrap();
    assert_eq!(stored[0], (0, None, Some("phase-ai Easy".into()), None, Some("Test Precon".into())));
    assert_eq!((stored[2].0, stored[2].1.as_deref(), stored[2].3.as_deref()), (2, Some(host.as_str()), Some(version.as_str())));
    hub.stop(&id);

    // A rematch starts from the host again, with the precon still in the computer's seat, and
    // rolls for first.
    sqlx::query("UPDATE online_games SET stage = 'over' WHERE game_id = ?").bind(&id).execute(&pool).await.unwrap();
    sqlx::query("UPDATE games SET status = 'finished' WHERE id = ?").bind(&id).execute(&pool).await.unwrap();
    let (status, again) = request(&app, Method::POST, &format!("/api/play/{id}/rematch"), Some(&token), None).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    let lobby = load_row(&pool, again["id"].as_str().unwrap()).await.unwrap();
    let seats = lobby.seats();
    assert_eq!((lobby.stage.as_str(), lobby.first_seat), ("lobby", None));
    assert_eq!(seats[0].user_id.as_deref(), Some(host.as_str()));
    assert_eq!((seats[1].deck_id.as_deref(), seats[1].deck_version_id.as_deref()), (Some("precon:test-precon"), None));
    assert_eq!(seats[2].deck_id.as_deref(), Some(deck_id.as_str()));
    // The lobby's page says the seat is ready and that first is rolled for.
    let (_, page) = request(&app, Method::GET, &format!("/api/play/{}", lobby.game_id), Some(&token), None).await;
    assert_eq!((&page["seats"][1]["ready"], page.get("first")), (&serde_json::json!(true), None));
}

#[tokio::test]
async fn a_table_without_a_chosen_first_player_records_the_engines_roll() {
    use crate::testutil::{deck as make_deck, user};
    let mut st = crate::testutil::state().await;
    st.play = ready_hub(None);
    let pool = st.pool.clone();
    let (host, _) = user(&pool, "roll-host@example.com").await;
    let (friend, _) = user(&pool, "roll-friend@example.com").await;
    let cards = vec![
        crate::decks::DeckCard { oracle_id: "commander".into(), name: "Combat Celebrant".into(), qty: 1, board: crate::decks::Board::Commander },
        crate::decks::DeckCard { oracle_id: "land".into(), name: "Island".into(), qty: 99, board: crate::decks::Board::Main },
    ];
    let mut seats = Vec::new();
    for (n, account) in [&host, &friend].into_iter().enumerate() {
        let (deck, version) = make_deck(&pool, account, "Deck").await;
        sqlx::query("UPDATE deck_versions SET cards=? WHERE id=?").bind(serde_json::to_string(&cards).unwrap()).bind(&version).execute(&pool).await.unwrap();
        let mut s = seat(n as u8, "Player");
        s.user_id = Some(account.to_string());
        s.deck_id = Some(deck);
        s.deck_version_id = Some(version);
        seats.push(s);
    }
    sqlx::query("INSERT INTO games(id,mode,created_by,status,started_at) VALUES('rolled','online',?,'in_progress','2026-11-11T00:00:00Z')").bind(&host).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO online_games(game_id,code,host_id,stage,seats,created_at,updated_at) VALUES('rolled','ROLLED',?,'lobby',?,'t','t')")
        .bind(&host).bind(serde_json::to_string(&seats).unwrap()).execute(&pool).await.unwrap();
    start_game(&st, "rolled", &host).await.unwrap();
    // Nobody chose: the seats keep their places and the record says who the engine picked.
    let r = load_row(&pool, "rolled").await.unwrap();
    assert_eq!(r.seats().iter().map(|s| s.user_id.clone().unwrap()).collect::<Vec<_>>(), vec![host.clone(), friend.clone()]);
    let replay: String = sqlx::query_scalar("SELECT replay FROM online_games WHERE game_id='rolled'").fetch_one(&pool).await.unwrap();
    assert!(serde_json::from_str::<serde_json::Value>(&replay).unwrap()["header"]["first_player"].is_null());
    assert!(matches!(r.first_seat, Some(0 | 1)), "the engine's pick is one of the two seats: {:?}", r.first_seat);
    st.play.stop("rolled");
}

#[tokio::test]
async fn a_guest_plays_a_precon_against_the_computer_one_game_at_a_time() {
    use crate::guests::tests::{as_guest, become_guest, guest_server};
    use axum::http::{Method, StatusCode};
    let mut cfg = crate::testutil::config();
    cfg.open_signup = true;
    cfg.turnstile = Some(crate::config::Turnstile { site_key: "site".into(), secret: "test-secret".into() });
    let mut st = crate::testutil::state_with(cfg, crate::db::test_pool().await).await;
    st.play = ready_hub(None);
    let hub = st.play.clone();
    let (app, pool) = guest_server(Some(st)).await;
    let stock = vec![
        crate::lab::PreconCard { name: "Combat Celebrant".into(), oracle_id: None, qty: 1, board: crate::decks::Board::Commander },
        crate::lab::PreconCard { name: "Mountain".into(), oracle_id: None, qty: 99, board: crate::decks::Board::Main },
    ];
    sqlx::query("INSERT INTO precons (id, lab_id, name, set_code, commanders, color_identity, cards, source, content_sha256, imported_at) VALUES ('test-precon','precons/test-precon','Test Precon','TST','[\"Combat Celebrant\"]','R',?,'fixture','hash','2026-11-11')")
        .bind(serde_json::to_string(&stock).unwrap()).execute(&pool).await.unwrap();
    let guest = become_guest(&app).await;
    let guest_id: String = sqlx::query_scalar("SELECT id FROM users WHERE guest = 1").fetch_one(&pool).await.unwrap();

    // A friend's seat needs an account.
    let with_friend = serde_json::json!({ "seats": [{ "kind": "me", "precon_id": "test-precon" }, { "kind": "friend" }] });
    assert_eq!(as_guest(&app, Method::POST, "/api/play", Some(&guest), None, Some(with_friend)).await.0, StatusCode::FORBIDDEN);

    let seats = serde_json::json!({ "seats": [
        { "kind": "me", "precon_id": "test-precon" },
        { "kind": "ai", "precon_id": "test-precon", "difficulty": "Easy" },
    ] });
    let (status, made, _) = as_guest(&app, Method::POST, "/api/play", Some(&guest), None, Some(seats.clone())).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    let id = made["id"].as_str().unwrap().to_string();
    let r = load_row(&pool, &id).await.unwrap();
    assert_eq!(r.stage, "live");
    let mine = r.seats().into_iter().find(|s| s.kind == "human").unwrap();
    assert_eq!((mine.user_id.as_deref(), mine.deck_id.as_deref(), mine.name.as_str()), (Some(guest_id.as_str()), Some("precon:test-precon"), "Guest"));
    let stored: (Option<String>, Option<String>, Option<String>) =
        sqlx::query_as("SELECT user_id, deck_version_id, deck_label FROM game_seats WHERE game_id = ? AND user_id IS NOT NULL").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(stored, (Some(guest_id.clone()), None, Some("Test Precon".into())));
    // The game is the guest's to see.
    let (status, page, _) = as_guest(&app, Method::GET, &format!("/api/play/{id}"), Some(&guest), None, None).await;
    assert_eq!(status, StatusCode::OK, "{page}");

    // One unfinished game at a time, even asked for several at once.
    let tries = (0..4).map(|_| as_guest(&app, Method::POST, "/api/play", Some(&guest), None, Some(seats.clone())));
    let answers = futures_util::future::join_all(tries).await;
    assert!(answers.iter().all(|(status, _, _)| *status == StatusCode::CONFLICT), "{:?}", answers.iter().map(|a| a.0).collect::<Vec<_>>());
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM online_games WHERE host_id = ?").bind(&guest_id).fetch_one(&pool).await.unwrap(), 1);

    // A game left alone for an hour ends and goes, freeing the guest's place; an account's doesn't.
    let st = crate::testutil::state().await;
    let reaper = crate::routes::AppState { pool: pool.clone(), play: hub.clone(), ..st };
    assert_eq!(reap_idle_guest_games(&reaper).await.unwrap(), 0);
    sqlx::query("UPDATE online_games SET updated_at = '2026-01-01T00:00:00Z' WHERE game_id = ?").bind(&id).execute(&pool).await.unwrap();
    assert_eq!(reap_idle_guest_games(&reaper).await.unwrap(), 1);
    assert!(hub.live(&id).is_none());
    assert_eq!(as_guest(&app, Method::GET, &format!("/api/play/{id}"), Some(&guest), None, None).await.0, StatusCode::NOT_FOUND);
    let (status, made, _) = as_guest(&app, Method::POST, "/api/play", Some(&guest), None, Some(seats.clone())).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    let id = made["id"].as_str().unwrap().to_string();
    hub.stop(&id);

    // Deleting the guest takes its games with it.
    assert_eq!(as_guest(&app, Method::DELETE, "/api/guest/session", Some(&guest), None, None).await.0, StatusCode::OK);
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM online_games WHERE host_id = ?").bind(&guest_id).fetch_one(&pool).await.unwrap(), 0);
}

/// Bryan, 12 Nov 2026: a game left on an engine version this server can't run moves to the
/// current engine when it replays the same, and is closed (no winner) when it doesn't, so none is
/// left that nobody can play or finish.
#[tokio::test(flavor = "multi_thread")]
async fn games_on_a_retired_engine_move_over_when_they_replay_the_same_and_close_when_not() {
    use crate::testutil::{send as request, user};
    use axum::http::{Method, StatusCode};
    let mut st = crate::testutil::state().await;
    st.play = ready_hub(None);
    let hub = st.play.clone();
    let pool = st.pool.clone();
    let (host, token) = user(&pool, "upgrade-host@example.com").await;
    // A game the computer played a while on this engine, still going: its replay and public
    // log as saved.
    let (replay, lines) = std::thread::Builder::new()
        .stack_size(STACK)
        .spawn(|| {
            let ai = [(0u8, Difficulty::Easy), (1u8, Difficulty::Easy)];
            let mut m = engine().new_match_first(11, vec![deck(&[("Island", 99)]), deck(&[("Mountain", 99)])], &ai, Some(1)).unwrap();
            m.run_ai(300).unwrap();
            assert!(!m.is_over());
            (m.replay_json(), m.log_lines().to_vec())
        })
        .unwrap()
        .join()
        .unwrap();
    assert!(lines.iter().any(|l| l.seat.is_none()), "the fixture game wrote public lines");
    // Seat 0 is a person now, so a game that moves over waits for them rather than playing out.
    let mut seats = vec![seat(0, "Ana"), seat(1, "Computer")];
    seats[0].user_id = Some(host.clone());
    seats[1].user_id = None;
    seats[1].kind = "ai".into();
    seats[1].difficulty = Some("Easy".into());
    let log = serde_json::to_string(&lines).unwrap();
    let mut tampered = lines.clone();
    let last = tampered.iter_mut().rev().find(|l| l.seat.is_none()).unwrap();
    last.text.push_str(" (not what happened)");
    let cases = [
        ("moves", Some("phase-v0.113.0+0571ee32-yama1/cards-eb309108"), replay.as_str(), log.clone()),
        ("unrecorded", None, replay.as_str(), log.clone()),
        ("differs", Some("phase-old"), replay.as_str(), serde_json::to_string(&tampered).unwrap()),
        ("unreadable", Some("phase-old"), "NOT JSON", log.clone()),
        ("no-log", Some("phase-old"), replay.as_str(), log.clone()),
    ];
    for (id, identity, replay, log) in &cases {
        saved_game(&pool, id, &host, *identity, "live", replay).await;
        sqlx::query("UPDATE online_games SET seats = ?, log = ? WHERE game_id = ?")
            .bind(serde_json::to_string(&seats).unwrap())
            .bind(log)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }
    // Without its saved log a game can't be checked, however well it replays.
    sqlx::query("UPDATE online_games SET log = NULL WHERE game_id = 'no-log'").execute(&pool).await.unwrap();
    hub.resume_live(&pool).await;
    let state = |id: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query_as::<_, (String, Option<String>, String, Option<String>)>(
                "SELECT o.stage, g.engine_version, g.status, o.log FROM online_games o JOIN games g ON g.id = o.game_id WHERE g.id = ?",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    // Replays the same: now on the current engine, running, its log saying it moved.
    for id in ["moves", "unrecorded"] {
        let (stage, engine_version, status, log) = state(id).await;
        assert_eq!((stage.as_str(), engine_version.as_deref(), status.as_str()), ("live", Some(yama_play::ENGINE_VERSION), "in_progress"), "{id}");
        assert!(log.unwrap().contains(yama_play::MOVED_NOTE), "{id}");
        assert!(hub.live(id).is_some(), "{id} runs");
        let (code, detail) = request(&crate::routes::app(st.clone()), Method::GET, &format!("/api/play/{id}"), Some(&token), None).await;
        assert_eq!(code, StatusCode::OK);
        assert!(detail["runtime_error"].is_null(), "{detail}");
    }
    let original: (String, String) = sqlx::query_as("SELECT engine_version, replay FROM online_game_originals WHERE game_id = 'moves'").fetch_one(&pool).await.unwrap();
    assert_eq!(original.0, "phase-v0.113.0+0571ee32-yama1/cards-eb309108");
    assert_eq!(original.1, replay, "the original replay is kept");
    let unrecorded: String = sqlx::query_scalar("SELECT engine_version FROM online_game_originals WHERE game_id = 'unrecorded'").fetch_one(&pool).await.unwrap();
    assert_eq!(unrecorded, "unrecorded");
    // Doesn't: closed without a winner, its old engine and original kept, nothing running.
    for id in ["differs", "unreadable", "no-log"] {
        let (stage, engine_version, status, log) = state(id).await;
        assert_eq!((stage.as_str(), engine_version.as_deref(), status.as_str()), ("over", Some("phase-old"), "abandoned"), "{id}");
        assert!(log.unwrap().contains("This game was closed without a winner"), "{id}");
        assert!(hub.live(id).is_none(), "{id}");
        let winner: Option<i64> = sqlx::query_scalar("SELECT winner_seat FROM games WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(winner, None);
        let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM online_game_originals WHERE game_id = ? AND stage = 'live'").bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(kept, 1, "{id}");
    }
    // A closed game no longer counts toward the host's open games, and isn't stranded.
    let (_, detail) = request(&crate::routes::app(st.clone()), Method::GET, "/api/play/differs", Some(&token), None).await;
    assert_eq!(detail["status"], "abandoned", "{detail}");
    assert_eq!(detail.get("stranded"), None, "{detail}");
    for id in ["moves", "unrecorded"] {
        hub.stop(id);
    }
}

#[test]
fn a_replayed_log_must_match_the_saved_one_from_the_end() {
    let line = |turn, text: &str| yama_play::LogLine::public(turn, text.into());
    let replayed = [line(1, "a"), line(1, "b"), line(2, "c")];
    // The saved log keeps only the latest lines; Yama's own and one seat's lines aren't compared.
    let mut private = line(2, "Yama answered yes for Rhystic Study, as you asked.");
    private.seat = Some(0);
    let saved = [line(1, "b"), line(2, "Ana conceded."), private, line(2, "c")];
    assert_eq!(yama_play::check_replayed_log(&saved, &replayed), Ok(()));
    assert!(yama_play::check_replayed_log(&[line(1, "b"), line(2, "x")], &replayed).is_err());
    assert!(yama_play::check_replayed_log(&[line(1, "b")], &replayed).is_err(), "the replay went further than the save");
    assert!(yama_play::check_replayed_log(&[line(1, "z"), line(1, "a"), line(1, "b"), line(2, "c")], &replayed).is_err());
    assert!(yama_play::check_replayed_log(&[line(1, "c")], &[line(2, "c")]).is_err(), "turns must match");
    assert!(yama_play::check_replayed_log(&[], &replayed).is_err(), "nothing saved to check against");
    assert!(yama_play::check_replayed_log(&[line(2, "Ana conceded.")], &replayed).is_err(), "only Yama's own lines saved");
    assert_eq!(yama_play::check_replayed_log(&[], &[]), Ok(()), "a game with no lines yet");
}
