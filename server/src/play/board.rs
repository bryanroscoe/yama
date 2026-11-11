//! phase's own board on a Yama game (`/api/play/{id}/board`): the part of phase-server's
//! WebSocket protocol its web client needs to play a seat or watch. The game itself stays on
//! Yama's game thread, with Yama's AI seats, passes for people, replay log and saves; the board
//! only sends engine actions and gets each viewer's filtered game back (`yama_play::board`).
//!
//! Who may connect is decided as for `/api/play/{id}/ws`: the signed-in account, by cookie. A
//! seated account may play only after attaching as its own viewer; choosing to watch is
//! read-only even for a seated account. The reconnect token phase's client keeps is only
//! echoed back: the cookie and attached viewer are the boundary.

use super::*;
use axum::extract::ws::CloseFrame;
use yama_play::board::{self as wire, ClientMessage as Wire, GameAction, InteractionSubmission, PlayerId, Rejection, ServerMessage, SPECTATOR};

pub(super) type Updates = HashMap<Option<u8>, Arc<[Arc<str>]>>;

pub(super) fn supports_runtime(stage: &str, identity: Option<&str>) -> bool {
    stage == "live" && identity == Some(yama_play::ENGINE_VERSION)
}

pub(super) struct Opened {
    pub first: Arc<str>,
    pub updates: broadcast::Receiver<Arc<Updates>>,
}

#[derive(Debug)]
enum SocketFrame {
    Text(Arc<str>),
    Lagged,
}

#[derive(Clone)]
struct Outbox(tokio::sync::mpsc::Sender<SocketFrame>);

impl Outbox {
    async fn send(&self, frame: Arc<str>) -> Result<(), tokio::sync::mpsc::error::SendError<SocketFrame>> {
        self.0.send(SocketFrame::Text(frame)).await
    }
}

fn outbox() -> (Outbox, tokio::sync::mpsc::Receiver<SocketFrame>) {
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    (Outbox(tx), rx)
}

/// What phase's board sent to be applied.
pub(super) enum Move {
    Action(GameAction),
    Interaction(InteractionSubmission),
}

/// Only standing controls belong to the account; yields and holds remain game-local.
pub(super) enum Preference {
    FullControl(bool),
    Stops(Option<Stops>),
}

impl Preference {
    pub(super) async fn save(&self, pool: &SqlitePool, user: &str) -> sqlx::Result<()> {
        // Atomic, field-specific updates preserve settings changed in another game.
        // For a new row, SQLite supplies the other controls' usual defaults.
        match self {
            Self::FullControl(on) => {
                sqlx::query(
                    "INSERT INTO play_prefs (user_id, full_control, updated_at) VALUES (?, ?, ?)
                     ON CONFLICT(user_id) DO UPDATE SET full_control = excluded.full_control, updated_at = excluded.updated_at",
                ).bind(user).bind(i64::from(*on)).bind(now()).execute(pool).await?;
            }
            Self::Stops(stops) => {
                let stops = stops.as_ref().map(|s| serde_json::to_string(s).expect("stops are serializable"));
                sqlx::query(
                    "INSERT INTO play_prefs (user_id, stops, updated_at) VALUES (?, ?, ?)
                     ON CONFLICT(user_id) DO UPDATE SET stops = excluded.stops, updated_at = excluded.updated_at",
                ).bind(user).bind(stops).bind(now()).execute(pool).await?;
            }
        }
        Ok(())
    }
}

pub(super) fn apply(m: &mut Match, seat: u8, mv: Move) -> Result<Option<Preference>, Rejection> {
    let action = match mv {
        Move::Action(action) => {
            m.submit(seat, action.clone())?;
            action
        }
        Move::Interaction(submission) => m.submit_interaction_action(seat, submission)?,
    };
    let controls = m.controls(seat);
    Ok(match action {
        GameAction::SetPriorityPassingMode { .. } => Some(Preference::FullControl(controls.full_control)),
        GameAction::SetPhaseStops { .. } => Some(Preference::Stops(controls.stops)),
        _ => None,
    })
}

fn viewer_id(viewer: Option<u8>) -> PlayerId {
    viewer.map(PlayerId).unwrap_or(SPECTATOR)
}

fn text(msg: &ServerMessage) -> Arc<str> {
    serde_json::to_string(msg).unwrap_or_default().into()
}

/// The `GameStarted` a viewer's board opens on (run on the game thread: the engine needs its stack).
pub(super) fn started(game_id: &str, m: &mut Match, viewer: Option<u8>) -> Result<Arc<str>, Rejection> {
    m.prepare_board()?;
    let token = viewer.map(|s| format!("yama-seat-{s}"));
    #[derive(serde::Serialize)]
    struct OpeningFrame {
        #[serde(flatten)]
        message: ServerMessage,
        gameplay_preferences: Option<wire::GameplayPreferences>,
    }
    let frame = OpeningFrame {
        message: wire::game_started(m.engine_state(), viewer_id(viewer), m.names(), m.revision, game_id, token),
        gameplay_preferences: viewer.map(|seat| m.board_preferences(seat)),
    };
    Ok(serde_json::to_string(&frame).expect("a board opening frame is serializable").into())
}

/// A viewer's frames after a change: the game as they may see it, then `GameOver` once it ends.
pub(super) fn frames(game_id: &str, m: &Match, viewer: Option<u8>, tail: &wire::Tail) -> Arc<[Arc<str>]> {
    let mut out = vec![text(&wire::state_update(m.engine_state(), viewer_id(viewer), m.revision, game_id, tail))];
    if m.is_over() {
        out.push(text(&ServerMessage::GameOver {
            winner: m.winner().map(PlayerId),
            reason: "The game is over.".into(),
            ranked_result: None,
        }));
    }
    out.into()
}

pub(super) async fn connect(
    State(st): State<AppState>,
    Player(user): Player,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    let r = load_visible(&st.pool, &id, &user.id).await?;
    if !supports_runtime(&r.stage, r.engine_version.as_deref()) {
        return Err(AppError::Conflict("Use Yama's original board for this saved runtime.".into()));
    }
    let you = r.seats().iter().find(|s| s.user_id.as_deref() == Some(user.id.as_str())).map(|s| s.seat);
    let live = st.play.live(&id).ok_or_else(|| AppError::Conflict("that game isn't running".into()))?;
    let prefs = if you.is_some() { load_prefs(&st.pool, &user.id).await? } else { None };
    Ok(ws.max_message_size(1_048_576).max_frame_size(1_048_576).on_upgrade(move |socket| run(socket, live, id, you, prefs)))
}

async fn run(socket: WebSocket, live: LiveGame, game_id: String, you: Option<u8>, prefs: Option<PlayPrefs>) {
    let (mut sink, mut stream) = socket.split();
    // A slow socket must not accumulate an unbounded history of whole boards.
    let (out, mut outbox) = outbox();
    let writer = tokio::spawn(async move {
        while let Some(frame) = outbox.recv().await {
            let message = match frame {
                SocketFrame::Text(frame) => Message::Text(frame.as_ref().into()),
                SocketFrame::Lagged => {
                    // The bounded history overflowed. Reconnect rather than silently
                    // continuing with missing animations and public log entries.
                    let _ = sink.send(Message::Close(Some(CloseFrame {
                        code: 1013,
                        reason: "Board updates fell behind. Reconnect to refresh.".into(),
                    }))).await;
                    break;
                }
            };
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });
    let _ = out.send(text(&wire::hello())).await;
    // The viewer this socket's board shows, once it has attached, and the task following the game.
    let mut attached: Attached = None;
    while let Some(Ok(msg)) = stream.next().await {
        if matches!(&msg, Message::Close(_)) { break; }
        let Message::Text(raw) = msg else { continue };
        let Ok(m) = serde_json::from_str::<Wire>(&raw) else {
            let _ = out.send(text(&ServerMessage::Error { message: "Yama doesn't understand that message.".into(), code: None })).await;
            continue;
        };
        match m {
            Wire::ClientHello { .. } => {}
            Wire::Ping { timestamp } => {
                let _ = out.send(text(&ServerMessage::Pong { timestamp })).await;
            }
            // A live Yama game has no stored final result to deliver: the board attaches.
            Wire::BootstrapTerminalDelivery { .. } => {
                let _ = out.send(text(&ServerMessage::TerminalBootstrapResult { delivery: None })).await;
            }
            Wire::Reconnect { game_code, .. } => {
                if !attach(&live, &out, &game_id, &game_code, you, prefs.as_ref(), &mut attached).await {
                    break;
                }
            }
            // A seated account may still choose to watch.
            Wire::SpectatorJoin { game_code } => {
                if !attach(&live, &out, &game_id, &game_code, None, None, &mut attached).await {
                    break;
                }
            }
            Wire::Action { action } => {
                submit(&live, &out, you, &attached, Move::Action(action)).await;
            }
            Wire::Interaction { submission } => {
                submit(&live, &out, you, &attached, Move::Interaction(submission)).await;
            }
            Wire::Concede | Wire::ConcedeMatch => {
                concede(&live, &out, you, &attached).await;
            }
            // Previews aren't offered yet: the board goes ahead without one.
            Wire::PreviewManaPayment { request_id, .. } => {
                let _ = out.send(text(&ServerMessage::ManaPaymentPreviewFailed { request_id, message: "Not available in Yama yet.".into() })).await;
            }
            Wire::PreviewInteraction { request } => {
                let _ = out.send(text(&ServerMessage::InteractionPreviewFailed {
                    request_id: request.request_id,
                    message: "Not available in Yama yet.".into(),
                })).await;
            }
            _ => {
                let _ = out.send(text(&ServerMessage::RequestRejected { reason: "Yama games don't offer that.".into() })).await;
            }
        }
    }
    if let Some((viewer, follower)) = attached {
        follower.abort();
        let _ = live.cmds.send(Cmd::BoardClosed { viewer });
    }
    drop(out);
    let _ = writer.await;
}

type Attached = Option<(Option<u8>, tokio::task::JoinHandle<()>)>;

/// Open the board on this game for `viewer`: its `GameStarted`, then every change. False when
/// the game thread has gone.
#[allow(clippy::too_many_arguments)]
async fn attach(
    live: &LiveGame,
    out: &Outbox,
    game_id: &str,
    game_code: &str,
    viewer: Option<u8>,
    prefs: Option<&PlayPrefs>,
    attached: &mut Attached,
) -> bool {
    if game_code != game_id {
        let _ = out.send(text(&ServerMessage::Error { message: "That isn't this game.".into(), code: None })).await;
        return true;
    }
    if attached.is_some() {
        return true;
    }
    // Initialize only a valid player attachment, never a spectator or a wrong
    // game code. FIFO admission puts refreshed defaults before its first frame;
    // initialize_prefs still preserves controls recovered from this replay.
    if let (Some(seat), Some(prefs)) = (viewer, prefs) {
        if live.cmds.send(Cmd::AccountPrefs { seat, prefs: prefs.clone() }).is_err() {
            return false;
        }
    }
    // The game thread subscribes while capturing the first frame, so this
    // receiver contains every later publication and no older snapshots.
    let (tx, rx) = oneshot::channel();
    if live.cmds.send(Cmd::BoardOpen { viewer, reply: tx }).is_err() {
        return false;
    }
    let opened = match rx.await {
        Ok(Ok(opened)) => opened,
        Ok(Err(rejection)) => {
            let _ = out.send(text(&ServerMessage::Error { message: rejection.message, code: None })).await;
            return false;
        }
        Err(_) => return false,
    };
    let _ = out.send(opened.first).await;
    *attached = Some((viewer, tokio::spawn(follow(opened.updates, viewer, out.clone()))));
    true
}

async fn playing_seat(out: &Outbox, you: Option<u8>, attached: &Attached) -> Option<u8> {
    let seat = you.filter(|seat| attached.as_ref().is_some_and(|(viewer, _)| *viewer == Some(*seat)));
    if seat.is_none() {
        let _ = out.send(text(&ServerMessage::RequestRejected { reason: "You're watching this game.".into() })).await;
    }
    seat
}

async fn concede(live: &LiveGame, out: &Outbox, you: Option<u8>, attached: &Attached) {
    if let Some(seat) = playing_seat(out, you, attached).await {
        let _ = live.cmds.send(Cmd::Concede { seat });
    }
}

async fn submit(live: &LiveGame, out: &Outbox, you: Option<u8>, attached: &Attached, mv: Move) {
    let Some(seat) = playing_seat(out, you, attached).await else { return };
    let (tx, rx) = oneshot::channel();
    if live.cmds.send(Cmd::Board { seat, mv, reply: tx }).is_err() {
        return;
    }
    match rx.await {
        Ok(Ok(())) => {}
        Ok(Err(rejection)) => {
            let _ = out.send(text(&ServerMessage::ActionRejected { rejection })).await;
        }
        Err(_) => {
            let _ = out.send(text(&ServerMessage::ActionFailed { message: "The game stopped.".into() })).await;
        }
    }
}

/// Send the viewer's frames every time the game changes, until it ends or the socket closes.
async fn follow(mut updates: broadcast::Receiver<Arc<Updates>>, viewer: Option<u8>, out: Outbox) {
    loop {
        let frames = match updates.recv().await {
            Ok(update) => update.get(&viewer).cloned(),
            Err(broadcast::error::RecvError::Closed) => return,
            Err(broadcast::error::RecvError::Lagged(_)) => {
                let _ = out.0.send(SocketFrame::Lagged).await;
                return;
            }
        };
        for frame in frames.iter().flat_map(|f| f.iter()) {
            if out.send(frame.clone()).await.is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestBoard {
        live: LiveGame,
        attached: Attached,
        out: Outbox,
        received: tokio::sync::mpsc::Receiver<SocketFrame>,
        commands: std::sync::mpsc::Receiver<Cmd>,
    }

    impl Drop for TestBoard {
        fn drop(&mut self) {
            if let Some((_, follower)) = &self.attached { follower.abort(); }
        }
    }

    async fn attached_board(viewer: Option<u8>) -> TestBoard {
        let (cmds, commands) = std::sync::mpsc::channel();
        let (_, views) = watch::channel(Arc::new(Snapshot::default()));
        let live = LiveGame { cmds, views };
        // Use the production attach path; only the game-thread reply is a fixture.
        let opener = tokio::task::spawn_blocking(move || {
            let Cmd::BoardOpen { viewer: actual, reply } = commands.recv().unwrap() else { panic!("board opening") };
            assert_eq!(actual, viewer);
            let (_, updates) = broadcast::channel(16);
            assert!(reply.send(Ok(Opened { first: "opening frame".into(), updates })).is_ok());
            commands
        });
        let (out, mut received) = outbox();
        let mut attached = None;
        assert!(attach(&live, &out, "g", "g", viewer, None, &mut attached).await);
        assert!(matches!(received.recv().await, Some(SocketFrame::Text(frame)) if &*frame == "opening frame"));
        TestBoard { live, attached, out, received, commands: opener.await.unwrap() }
    }

    async fn assert_watching_rejection(board: &mut TestBoard) {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), board.received.recv()).await.expect("a refusal");
        let Some(SocketFrame::Text(frame)) = frame else { panic!("a refusal") };
        assert!(matches!(serde_json::from_str::<ServerMessage>(&frame).unwrap(), ServerMessage::RequestRejected { .. }));
        assert!(matches!(board.commands.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)), "no mutation may reach the game thread");
    }

    async fn rejected_move(board: &mut TestBoard, you: Option<u8>, mv: Move) {
        tokio::time::timeout(std::time::Duration::from_secs(2), submit(&board.live, &board.out, you, &board.attached, mv))
            .await.expect("a watching socket must refuse before sending a command");
        assert_watching_rejection(board).await;
    }

    #[tokio::test]
    async fn watching_socket_cannot_send_a_raw_action_for_its_accounts_seat() {
        let mut board = attached_board(None).await;
        rejected_move(&mut board, Some(0), Move::Action(GameAction::PassPriority)).await;
    }

    #[tokio::test]
    async fn watching_socket_cannot_send_a_valid_interaction_for_its_accounts_seat() {
        let (_, mut m) = ordinary_game();
        let submission = offered_submission(&started("g", &mut m, Some(0)).unwrap());
        let mut board = attached_board(None).await;
        rejected_move(&mut board, Some(0), Move::Interaction(submission)).await;
    }

    #[tokio::test]
    async fn watching_socket_cannot_concede_its_accounts_seat() {
        let mut board = attached_board(None).await;
        concede(&board.live, &board.out, Some(0), &board.attached).await;
        assert!(matches!(board.commands.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)), "a spectator cannot concede");
        assert_watching_rejection(&mut board).await;
    }

    #[tokio::test]
    async fn a_board_without_a_matching_authenticated_attachment_cannot_mutate() {
        let mut board = attached_board(Some(0)).await;
        for you in [None, Some(1)] {
            rejected_move(&mut board, you, Move::Action(GameAction::PassPriority)).await;
            concede(&board.live, &board.out, you, &board.attached).await;
            assert_watching_rejection(&mut board).await;
        }
        board.attached.take().unwrap().1.abort();
        rejected_move(&mut board, Some(0), Move::Action(GameAction::PassPriority)).await;
        concede(&board.live, &board.out, Some(0), &board.attached).await;
        assert_watching_rejection(&mut board).await;
    }

    #[tokio::test]
    async fn a_matching_player_attachment_still_forwards_moves_and_concessions() {
        let mut board = attached_board(Some(0)).await;
        let (_, mut m) = ordinary_game();
        let submission = offered_submission(&started("g", &mut m, Some(0)).unwrap());
        for mv in [Move::Action(GameAction::PassPriority), Move::Interaction(submission)] {
            tokio::join!(
                submit(&board.live, &board.out, Some(0), &board.attached, mv),
                async {
                    tokio::task::yield_now().await;
                    let Cmd::Board { seat, reply, .. } = board.commands.try_recv().expect("a player submission") else { panic!("a move") };
                    assert_eq!(seat, 0);
                    assert!(reply.send(Ok(())).is_ok());
                }
            );
        }
        concede(&board.live, &board.out, Some(0), &board.attached).await;
        assert!(matches!(board.commands.try_recv(), Ok(Cmd::Concede { seat: 0 })));
        assert!(board.received.try_recv().is_err(), "accepted commands send no refusal");
    }

    fn ordinary_game() -> (Engine, Match) {
        let e = Engine::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../play/tests/fixtures/combat-cards.json")).unwrap();
        let deck = SeatDeck { companion: vec![], commander: vec!["Combat Celebrant".into()], main: vec!["Mountain".into(); 99] };
        let other = SeatDeck { companion: vec![], commander: vec!["Combat Celebrant".into()], main: vec!["Grizzly Bears".into(); 99] };
        let m = e.new_match_first(7, vec![deck, other], &[], Some(0)).unwrap();
        (e, m)
    }

    #[tokio::test]
    async fn direct_player_reconnect_refreshes_defaults_but_spectators_and_replays_keep_their_controls() {
        async fn opening(live: &LiveGame, id: &str, code: &str, viewer: Option<u8>, prefs: Option<&PlayPrefs>) -> serde_json::Value {
            let (out, mut received) = outbox();
            let mut attached = None;
            assert!(attach(live, &out, id, code, viewer, prefs, &mut attached).await);
            let Some(SocketFrame::Text(frame)) = received.recv().await else { panic!("opening frame") };
            let value = serde_json::from_str(&frame).unwrap();
            if let Some((viewer, follower)) = attached {
                follower.abort();
                live.cmds.send(Cmd::BoardClosed { viewer }).unwrap();
            }
            value
        }
        for restored in [false, true] {
            let pool = crate::db::test_pool().await;
            let (owner, _) = crate::testutil::user(&pool, "direct-board@example.com").await;
            let (engine, mut matched) = ordinary_game();
            if restored {
                matched.set_full_control(0, true);
                matched = engine.resume(&matched.replay_json(), &[]).unwrap();
            }
            let id = format!("direct-board-{restored}");
            let seats: Vec<_> = (0..2).map(|seat| SeatCfg {
                seat, kind: "human".into(), user_id: (seat == 0).then(|| owner.clone()), name: format!("Seat {seat}"),
                deck_id: None, deck_version_id: None, deck_name: None, color_identity: String::new(),
                commander: None, difficulty: None, bracket: None,
            }).collect();
            sqlx::query("INSERT INTO games(id,mode,created_by,format,status,starting_life,started_at,engine_version) VALUES (?,'online',?,'commander','in_progress',40,'original',?)")
                .bind(&id).bind(&owner).bind(yama_play::ENGINE_VERSION).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO online_games(game_id,code,host_id,stage,seats,replay,revision,created_at,updated_at) VALUES (?,?,?,'live',?,?,0,'original','original')")
                .bind(&id).bind(&id).bind(&owner).bind(serde_json::to_string(&seats).unwrap()).bind(matched.replay_json()).execute(&pool).await.unwrap();
            let hub = Arc::new(PlayHub {
                engine: Mutex::new(EngineState::Ready(Arc::new(engine))), live: Mutex::new(HashMap::new()),
                historical: None, setup_gate: Arc::new(tokio::sync::Semaphore::new(1)), unavailable: Mutex::new(HashMap::new()),
            });
            hub.spawn_game(id.clone(), matched, seats, HashMap::new(), pool.clone());
            let live = hub.live(&id).unwrap();
            // Another device changed the account after this game started.
            let account = PlayPrefs { stops: None, full_control: !restored, tap_mana: PayMode::Manual };
            save_prefs(&pool, &owner, &account).await.unwrap();
            let prefs = load_prefs(&pool, &owner).await.unwrap();
            let refused = opening(&live, &id, "another-game", Some(0), prefs.as_ref()).await;
            assert_eq!(refused["type"], "Error");
            let spectator = opening(&live, &id, &id, None, prefs.as_ref()).await;
            assert!(spectator["gameplay_preferences"].is_null());
            let unchanged = opening(&live, &id, &id, Some(0), None).await;
            assert_eq!(unchanged["gameplay_preferences"]["full_control"], restored, "wrong-code and spectator attachments never initialize a seat");
            let refreshed = opening(&live, &id, &id, Some(0), prefs.as_ref()).await;
            assert_eq!(refreshed["gameplay_preferences"]["full_control"], true, "new defaults apply, while replay-restored Full control wins over account false");
            assert_eq!(load_prefs(&pool, &owner).await.unwrap(), Some(account));
            hub.stop(&id);
        }
    }

    fn offered_submission(frame: &str) -> InteractionSubmission {
        let ServerMessage::GameStarted { viewer_interaction, .. } = serde_json::from_str(frame).unwrap() else { panic!("the initial frame") };
        assert!(viewer_interaction.can_submit, "ordinary games must have bound interaction authority");
        assert!(!viewer_interaction.opportunities.is_empty());
        let availability = serde_json::to_value(viewer_interaction.availability).unwrap();
        serde_json::from_value(availability["data"]["witness"].clone()).expect("the engine offers a complete opening-hand response")
    }

    #[test]
    fn opening_an_ordinary_game_prepares_usable_private_interactions() {
        let (_, mut m) = ordinary_game();
        assert!(m.engine_state().interaction_session_id.is_none(), "headless construction stays unchanged");
        let saved = m.replay_json();
        let first = started("g", &mut m, Some(0)).unwrap();
        assert_eq!(m.replay_json(), saved, "preparing capabilities records no game action");
        assert!(!first.contains("Grizzly Bears"), "the initial frame keeps the other hand and library private");
        let submission = offered_submission(&first);
        let namespace = m.engine_state().interaction_session_id.clone();
        let _second_connection = started("g", &mut m, Some(0)).unwrap();
        assert_eq!(m.engine_state().interaction_session_id, namespace);
        let logged = m.actions_logged();
        apply(&mut m, 0, Move::Interaction(submission)).unwrap();
        assert_eq!(m.actions_logged(), logged + 1, "the first connection's capability remains usable");
    }

    #[test]
    fn opening_a_resumed_board_advertises_saved_preferences_without_changing_them() {
        let (e, mut m) = ordinary_game();
        m.set_stops(0, Some(yama_play::Stops {
            own: ["Upkeep".into(), "Draw".into()].into(),
            others: ["Draw".into(), "End".into()].into(),
        }));
        m.set_full_control(0, true);
        let mut resumed = e.resume(&m.replay_json(), &[]).unwrap();
        let saved = resumed.replay_json();
        let frame: serde_json::Value = serde_json::from_str(&started("g", &mut resumed, Some(0)).unwrap()).unwrap();
        assert_eq!(frame["gameplay_preferences"], serde_json::json!({
            "full_control": true, "priority_passing_mode": "Standard",
            "phase_stops": [
                {"phase": "Draw", "scope": "AllTurns"},
                {"phase": "End", "scope": "OpponentsTurns"},
                {"phase": "Upkeep", "scope": "OwnTurn"},
            ],
        }));
        assert_eq!(resumed.replay_json(), saved, "opening records no preference actions");
        assert!(resumed.controls(0).full_control);
        let watched: serde_json::Value = serde_json::from_str(&started("g", &mut resumed, None).unwrap()).unwrap();
        assert!(watched["gameplay_preferences"].is_null(), "watchers receive no seat's preferences");
    }

    #[test]
    fn opening_a_resumed_hold_keeps_it_temporary() {
        let (e, mut m) = ordinary_game();
        m.set_hold(0, true);
        let mut resumed = e.resume(&m.replay_json(), &[]).unwrap();
        let saved = resumed.replay_json();
        let frame: serde_json::Value = serde_json::from_str(&started("g", &mut resumed, Some(0)).unwrap()).unwrap();
        assert_eq!(frame["gameplay_preferences"]["full_control"], false);
        assert_eq!(frame["gameplay_preferences"]["priority_passing_mode"], "Standard");
        assert!(resumed.controls(0).hold);
        assert!(!resumed.controls(0).full_control);
        assert_eq!(resumed.replay_json(), saved);
    }

    #[test]
    fn opening_a_resumed_game_rekeys_capabilities_and_rejects_abandoned_ones() {
        let (e, mut m) = ordinary_game();
        let keep: GameAction = serde_json::from_value(serde_json::json!({ "type": "MulliganDecision", "data": { "choice": { "type": "Keep" } } })).unwrap();
        apply(&mut m, 0, Move::Action(keep)).unwrap();
        let old_frame = started("g", &mut m, Some(1)).unwrap();
        let abandoned = offered_submission(&old_frame);
        let old_namespace = m.engine_state().interaction_session_id.clone();
        let mut resumed = e.resume(&m.replay_json(), &[]).unwrap();
        let restored_frame = started("g", &mut resumed, Some(1)).unwrap();
        let current = offered_submission(&restored_frame);
        assert_ne!(resumed.engine_state().interaction_session_id, old_namespace);
        let before = serde_json::to_value(resumed.engine_state()).unwrap();
        let logged = resumed.actions_logged();
        assert!(apply(&mut resumed, 1, Move::Interaction(abandoned)).is_err());
        assert_eq!(serde_json::to_value(resumed.engine_state()).unwrap(), before);
        assert_eq!(resumed.actions_logged(), logged);
        apply(&mut resumed, 1, Move::Interaction(current)).unwrap();
        assert_eq!(resumed.actions_logged(), logged + 1);
        let replayed = e.resume(&resumed.replay_json(), &[]).unwrap();
        assert_eq!(replayed.actions_logged(), resumed.actions_logged());
        assert_eq!(serde_json::to_value(&replayed.engine_state().waiting_for).unwrap(), serde_json::to_value(&resumed.engine_state().waiting_for).unwrap());
    }

    #[test]
    fn only_a_live_matching_runtime_supports_the_current_phase_board() {
        assert!(supports_runtime("live", Some(yama_play::ENGINE_VERSION)));
        for identity in [None, Some(history::IDENTITY), Some("unknown-runtime")] {
            assert!(!supports_runtime("live", identity));
        }
        for stage in ["lobby", "over", "abandoned"] {
            assert!(!supports_runtime(stage, Some(yama_play::ENGINE_VERSION)));
        }
    }

    #[tokio::test]
    async fn an_update_while_opening_the_board_is_delivered() {
        let (changes, updates) = broadcast::channel(16);
        let mut next = Updates::new();
        next.insert(None, vec![Arc::<str>::from("newest state")].into());
        changes.send(Arc::new(next)).unwrap();
        let (out, mut received) = outbox();
        let follower = tokio::spawn(follow(updates, None, out));
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), received.recv()).await.unwrap().unwrap();
        assert!(matches!(frame, SocketFrame::Text(frame) if &*frame == "newest state"));
        drop(changes);
        follower.await.unwrap();
    }

    #[tokio::test]
    async fn consecutive_publications_keep_each_tail_for_every_viewer() {
        let (changes, first) = broadcast::channel(16);
        let second = changes.subscribe();
        for tail in ["action and its public log", "empty end-of-loop tail"] {
            changes.send(Arc::new(Updates::from([
                (Some(0), vec![Arc::<str>::from(tail)].into()),
                (Some(1), vec![Arc::<str>::from(format!("seat 1: {tail}"))].into()),
            ]))).unwrap();
        }
        drop(changes);
        for (viewer, updates, prefix) in [(Some(0), first, ""), (Some(1), second, "seat 1: ")] {
            let (out, mut received) = outbox();
            follow(updates, viewer, out).await;
            for tail in ["action and its public log", "empty end-of-loop tail"] {
                assert!(matches!(received.recv().await, Some(SocketFrame::Text(frame)) if &*frame == format!("{prefix}{tail}")));
            }
            assert!(received.recv().await.is_none());
        }
    }

    #[tokio::test]
    async fn an_empty_followup_publication_does_not_erase_engine_events_or_logs() {
        let e = Engine::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../play/tests/fixtures/combat-cards.json")).unwrap();
        let deck = SeatDeck { companion: vec![], commander: vec!["Combat Celebrant".into()], main: vec!["Mountain".into(); 99] };
        let mut m = e.new_match_first(7, vec![deck.clone(), deck], &[], Some(0)).unwrap();
        m.prepare_board().unwrap();
        m.take_board_tail();
        m.concede(0).unwrap();
        let tail = m.take_board_tail();
        let first = frames("g", &m, None, &tail);
        let empty = m.take_board_tail();
        let last = frames("g", &m, None, &empty);
        let (changes, updates) = broadcast::channel(16);
        changes.send(Arc::new(Updates::from([(None, first)]))).unwrap();
        changes.send(Arc::new(Updates::from([(None, last)]))).unwrap();
        drop(changes);
        let (out, mut received) = outbox();
        follow(updates, None, out).await;
        let mut states = Vec::new();
        while let Some(SocketFrame::Text(frame)) = received.recv().await {
            let message: ServerMessage = serde_json::from_str(&frame).unwrap();
            if let ServerMessage::StateUpdate { events, log_entries, .. } = message {
                states.push((events.len(), log_entries.len()));
            }
        }
        assert_eq!(states.len(), 2);
        assert_ne!(states[0], (0, 0));
        assert_eq!(states[1], (0, 0));
    }

    #[tokio::test]
    async fn an_overflow_requires_reconnecting_instead_of_silently_skipping_tails() {
        let (changes, updates) = broadcast::channel(2);
        for _ in 0..3 { changes.send(Arc::new(Updates::new())).unwrap(); }
        let (out, mut received) = outbox();
        follow(updates, None, out).await;
        assert!(matches!(received.recv().await, Some(SocketFrame::Lagged)));
        assert!(received.recv().await.is_none());
    }
}
