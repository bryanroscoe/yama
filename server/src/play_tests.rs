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
    // Only the remembering forms the whitelist spells: not the engine's own preference actions.
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"set_may_trigger_auto_choice","op":{}}}"#));
    assert!(!ok(r#"{"type":"act","revision":3,"action":{"kind":"choose_replacement_and_remember","choice":{"type":"forget"}}}"#));
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
    hub.spawn_game("game-act-1".into(), m, vec![seat(0, "Ana"), seat(1, "Ben")], pool.clone());
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
