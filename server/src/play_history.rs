//! A historical adapter is a separate executable, never a current-engine replay fallback.
//! Only this authenticated server reads/writes SQLite; the child receives server-selected sessions and shares one verified card database.
use super::*;
use anyhow::{Context, ensure};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Condvar, mpsc};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

pub(super) const IDENTITY: &str = "phase-v0.113.0+a3bc47c9-yama/cards-1e5608e6";
const MANIFEST: &str = include_str!("../../runtime/historical.json");
const SOURCE: &str = include_str!("../../runtime/historical-source.json");
const DEADLINE: Duration = Duration::from_secs(60);
const MAX_RESPONSE: u64 = 128 << 20;

#[derive(Clone)]
pub(super) struct Config {
    pub binary: PathBuf,
    pub data: PathBuf,
    pub digest: PathBuf,
    deadline: Duration,
    queue_deadline: Duration,
    process: Arc<Mutex<Result<std::sync::Weak<Process>, String>>>,
}
impl Config {
    pub fn discover(current_data: &std::path::Path) -> Self {
        let mut config = Self::new(
            std::env::var_os("YAMA_HISTORICAL_RUNTIME")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::current_exe()
                        .unwrap_or_default()
                        .with_file_name("historical-runtime")
                }),
            std::env::var_os("YAMA_HISTORICAL_CARD_DATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| current_data.with_file_name("card-data-1e5608e61683de41.json")),
        );
        config.digest = std::env::var_os("YAMA_HISTORICAL_RUNTIME_DIGEST")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/usr/local/share/yama/historical-runtime.sha256"));
        config
    }
    pub fn new(binary: PathBuf, data: PathBuf) -> Self {
        let digest = binary.with_extension("sha256");
        Self {
            binary,
            data,
            digest,
            deadline: DEADLINE,
            queue_deadline: DEADLINE,
            process: Arc::new(Mutex::new(Ok(std::sync::Weak::new()))),
        }
    }
    #[cfg(test)]
    pub(super) fn test_deadlines(&mut self, active: Duration, queued: Duration) {
        self.deadline = active;
        self.queue_deadline = queued;
    }
    pub fn available(&self) -> bool {
        self.binary.is_file() && self.data.is_file() && self.digest.is_file()
    }
}

/// Overload is retryable only while the request is known not to have executed.
#[derive(Debug, thiserror::Error)]
#[error("The historical runtime is busy. No action was applied; please retry shortly.")]
pub(super) struct Busy;

const QUEUED: u8 = 0;
const ACTIVE: u8 = 1;
const CANCELLED: u8 = 2;
const QUEUE_CAPACITY: usize = 64;
enum Response {
    Started(Instant),
    Finished(anyhow::Result<Value>),
}
struct Request {
    value: Value,
    phase: Arc<AtomicU8>,
    reply: mpsc::Sender<Response>,
}
struct Pending {
    phase: Arc<AtomicU8>,
    response: mpsc::Receiver<Response>,
}
impl Drop for Pending {
    fn drop(&mut self) {
        // A caller that leaves before dispatch cannot cause a later mutation.
        let _ = self.phase.compare_exchange(QUEUED, CANCELLED, Ordering::SeqCst, Ordering::SeqCst);
    }
}
#[derive(Default)]
struct Queue {
    requests: VecDeque<Request>,
    // Reserved cleanup lane, one entry per successfully opened, dropped Worker.
    // FIFO closes run before new requests, so later traffic cannot starve them.
    closes: VecDeque<String>,
    active: Option<Instant>,
    stopped: bool,
}
#[derive(Default)]
struct Schedule {
    queue: Mutex<Queue>,
    changed: Condvar,
}
struct Process {
    child: Arc<Mutex<Child>>,
    schedule: Arc<Schedule>,
    alive: Arc<AtomicBool>,
    reaping: Arc<AtomicBool>,
    deadline: Duration,
    queue_deadline: Duration,
}
impl Process {
    fn stop(&self) {
        stop_process(&self.child, &self.alive, &self.reaping, &self.schedule);
    }
    fn start(config: &Config) -> anyhow::Result<Self> {
        use sha2::{Digest, Sha256};
        // Independent build output, not a self-reported greeting. Check before execution/replay.
        let binding = std::fs::read_to_string(&config.digest)
            .context("historical runtime artifact binding unavailable")?;
        let expected = binding
            .split_whitespace()
            .next()
            .context("historical runtime artifact binding invalid")?;
        let mut file = std::fs::File::open(&config.binary)?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        let actual = hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        ensure!(
            actual == expected,
            "historical runtime executable provenance mismatch"
        );
        let mut child = Command::new(&config.binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_clear()
            .spawn()
            .context("historical runtime is unavailable")?;
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let (hello_tx, hello_rx) = mpsc::channel();
        let alive = Arc::new(AtomicBool::new(true));
        let process = Self {
            child: Arc::new(Mutex::new(child)),
            schedule: Arc::new(Schedule::default()),
            alive,
            reaping: Arc::new(AtomicBool::new(false)),
            deadline: config.deadline,
            queue_deadline: config.queue_deadline,
        };
        let worker_alive = process.alive.clone();
        let worker_child = process.child.clone();
        let worker_reaping = process.reaping.clone();
        let worker_schedule = process.schedule.clone();
        let supervisor_alive = process.alive.clone();
        let supervisor_child = process.child.clone();
        let supervisor_reaping = process.reaping.clone();
        let supervisor_schedule = process.schedule.clone();
        let deadline = config.deadline;
        std::thread::Builder::new().name("historical-supervisor".into()).spawn(move || {
            let mut queue = supervisor_schedule.queue.lock().unwrap();
            loop {
                if queue.stopped { return; }
                if let Some(started) = queue.active {
                    let remaining = deadline.saturating_sub(started.elapsed());
                    if remaining.is_zero() {
                        drop(queue);
                        stop_process(&supervisor_child, &supervisor_alive, &supervisor_reaping, &supervisor_schedule);
                        return;
                    }
                    queue = supervisor_schedule.changed.wait_timeout(queue, remaining).unwrap().0;
                } else {
                    queue = supervisor_schedule.changed.wait(queue).unwrap();
                }
            }
        })?;
        std::thread::Builder::new()
            .name("historical-pipes".into())
            .spawn(move || {
                let hello = read_response(&mut output);
                let ready = hello.is_ok();
                let _ = hello_tx.send(hello);
                if !ready {
                    stop_process(&worker_child, &worker_alive, &worker_reaping, &worker_schedule);
                    return;
                }
                loop {
                    let (value, reply, closing) = {
                        let mut queue = worker_schedule.queue.lock().unwrap();
                        loop {
                            if queue.stopped { return; }
                            let next = if let Some(session) = queue.closes.pop_front() {
                                Some((json!({"op":"close", "session":session}), None, true))
                            } else if let Some(request) = queue.requests.pop_front() {
                                if request.phase.compare_exchange(QUEUED, ACTIVE, Ordering::SeqCst, Ordering::SeqCst).is_err() {
                                    continue;
                                }
                                Some((request.value, Some(request.reply), false))
                            } else { None };
                            if let Some((value, reply, closing)) = next {
                                let started = Instant::now();
                                queue.active = Some(started);
                                if let Some(reply) = &reply { let _ = reply.send(Response::Started(started)); }
                                worker_schedule.changed.notify_all();
                                break (value, reply, closing);
                            }
                            queue = worker_schedule.changed.wait(queue).unwrap();
                        }
                    };
                    let mut result: anyhow::Result<Value> = (|| {
                        serde_json::to_writer(&mut input, &value)?;
                        input.write_all(b"\n")?;
                        input.flush()?;
                        let response = read_response(&mut output)?;
                        ensure!(!closing || response["closed"] == true, "historical runtime failed to close its session");
                        Ok(response)
                    })();
                    {
                        let mut queue = worker_schedule.queue.lock().unwrap();
                        queue.active = None;
                        if queue.stopped { result = Err(anyhow::anyhow!("historical runtime stopped during I/O; restart recovery is required")); }
                        worker_schedule.changed.notify_all();
                    }
                    let fatal = result.as_ref().is_err_and(|e| closing || !e.is::<Rejected>());
                    if let Some(reply) = reply { let _ = reply.send(Response::Finished(result)); }
                    if fatal {
                        stop_process(&worker_child, &worker_alive, &worker_reaping, &worker_schedule);
                        return;
                    }
                }
            })?;
        let hello = hello_rx
            .recv_timeout(config.deadline)
            .context("historical runtime greeting timed out")??;
        let expected: Value = serde_json::from_str(MANIFEST)?;
        let source: Value = serde_json::from_str(SOURCE)?;
        ensure!(
            hello["hello"] == expected && hello["source"] == source,
            "historical runtime provenance mismatch"
        );
        Ok(process)
    }
    fn submit(&self, value: Value) -> anyhow::Result<Pending> {
        let mut queue = self.schedule.queue.lock().unwrap();
        ensure!(!queue.stopped, "historical runtime stopped; saved game is preserved");
        queue.requests.retain(|r| r.phase.load(Ordering::SeqCst) != CANCELLED);
        if queue.requests.len() >= QUEUE_CAPACITY { return Err(Busy.into()); }
        let (reply, response) = mpsc::channel();
        let phase = Arc::new(AtomicU8::new(QUEUED));
        queue.requests.push_back(Request { value, phase: phase.clone(), reply });
        self.schedule.changed.notify_all();
        Ok(Pending { phase, response })
    }
    fn call(&self, value: Value) -> anyhow::Result<Value> {
        let pending = self.submit(value)?;
        let started = match pending.response.recv_timeout(self.queue_deadline) {
            Ok(Response::Started(started)) => started,
            Ok(Response::Finished(_)) => unreachable!("dispatch always announces active I/O first"),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Atomic with the dispatcher: Busy guarantees that this command can
                // never execute later. An already active command is not retryable.
                if pending.phase.compare_exchange(QUEUED, CANCELLED, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                    return Err(Busy.into());
                }
                match pending.response.recv_timeout(self.deadline) {
                    Ok(Response::Started(started)) => started,
                    _ => { self.stop(); anyhow::bail!("historical runtime dispatch stopped; restart recovery is required"); }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => anyhow::bail!("historical runtime stopped; restart recovery is required"),
        };
        match pending.response.recv_timeout(self.deadline.saturating_sub(started.elapsed())) {
            Ok(Response::Finished(result)) => result,
            _ => {
                self.stop();
                anyhow::bail!("historical runtime active I/O timed out or stopped; restart recovery is required")
            }
        }
    }
    fn close(&self, session: String) {
        let mut queue = self.schedule.queue.lock().unwrap();
        if !queue.stopped {
            queue.closes.push_back(session);
            self.schedule.changed.notify_all();
        }
    }
}
// Child ownership is separate from pipes: neither kill nor reap can queue behind I/O.
fn stop_process(child: &Arc<Mutex<Child>>, alive: &AtomicBool, reaping: &AtomicBool, schedule: &Schedule) {
    alive.store(false, Ordering::SeqCst);
    {
        let mut queue = schedule.queue.lock().unwrap();
        queue.stopped = true;
        queue.requests.clear();
        queue.closes.clear();
        schedule.changed.notify_all();
    }
    if !reaping.swap(true, Ordering::SeqCst) {
        let child = child.clone();
        let _ = std::thread::Builder::new()
            .name("historical-reap".into())
            .spawn(move || {
                let mut child = child.lock().unwrap();
                let _ = child.kill();
                let _ = child.wait();
            });
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        self.stop();
    }
}
#[derive(Debug)]
struct Rejected(String);
impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Rejected {}
fn read_response(output: &mut impl BufRead) -> anyhow::Result<Value> {
    let mut line = String::new();
    let n = output.take(MAX_RESPONSE + 1).read_line(&mut line)?;
    ensure!(
        n > 0 && n as u64 <= MAX_RESPONSE && line.ends_with('\n'),
        "historical runtime stopped or exceeded response limit; saved game is preserved"
    );
    let v: Value = serde_json::from_str(&line).context("historical runtime protocol")?;
    if let Some(error) = v["error"].as_str() {
        return Err(Rejected(error.into()).into());
    }
    Ok(v)
}

pub(super) struct Worker {
    process: Arc<Process>,
    session: String,
    opened: bool,
}
impl Worker {
    pub fn start(config: &Config) -> anyhow::Result<Self> {
        let mut cached = config.process.lock().unwrap();
        let weak = cached
            .as_ref()
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        let process = match weak.upgrade() {
            Some(process) => {
                ensure!(
                    process.alive.load(Ordering::SeqCst),
                    "historical runtime stopped; restart recovery is required"
                );
                process
            }
            None => match Process::start(config) {
                Ok(process) => {
                    let process = Arc::new(process);
                    *cached = Ok(Arc::downgrade(&process));
                    process
                }
                Err(error) => {
                    *cached = Err(format!("{error:#}"));
                    return Err(error);
                }
            },
        };
        Ok(Self {
            process,
            session: uuid::Uuid::new_v4().to_string(),
            opened: false,
        })
    }
    #[cfg(test)]
    pub fn process_id(&self) -> u32 {
        self.process.child.lock().unwrap().id()
    }
    pub fn call(&mut self, mut v: Value) -> anyhow::Result<Value> {
        v["session"] = json!(self.session);
        self.process.call(v)
    }
    #[cfg(test)]
    pub(super) fn test_backlog(&self) -> TestBacklog {
        let mut pending = Vec::new();
        loop {
            match self.process.submit(json!({"op":"queued","session":self.session})) {
                Ok(request) => pending.push(request),
                Err(e) if e.is::<Busy>() => break,
                Err(e) => panic!("queue failed: {e:#}"),
            }
        }
        TestBacklog(pending)
    }
    #[cfg(test)]
    pub(super) fn test_session(&self) -> String { self.session.clone() }
    pub fn open(
        &mut self,
        config: &Config,
        replay: String,
        log: Option<String>,
        answers: Option<String>,
        seats: &[SeatCfg],
    ) -> anyhow::Result<Saved> {
        let ai: Vec<_> = seats
            .iter()
            .filter(|s| s.kind == "ai")
            .map(|s| (s.seat, s.difficulty.as_deref().unwrap_or("Medium")))
            .collect();
        let humans: Vec<_> = seats
            .iter()
            .filter(|s| s.kind == "human")
            .map(|s| s.seat)
            .collect();
        let parse = |s: Option<String>| s.map(|s| serde_json::from_str::<Value>(&s)).transpose();
        let v = self.call(json!({"op":"open", "identity":IDENTITY,"data":config.data,
            "replay":replay,"log":parse(log)?,"answers":parse(answers)?,"ai":ai,"humans":humans,
            "names":seats.iter().map(|s|&s.name).collect::<Vec<_>>()}))?;
        self.opened = true;
        Ok(serde_json::from_value(v["state"].clone())?)
    }
}

#[cfg(test)]
pub(super) struct TestBacklog(Vec<Pending>);
#[cfg(test)]
impl TestBacklog { pub(super) fn len(&self) -> usize { self.0.len() } }

impl Drop for Worker {
    fn drop(&mut self) {
        // Failed/cancelled opens own no child session. Cleanup of real sessions
        // has reserved admission and FIFO priority, independent of the full data
        // queue. Every preceding close/active operation has its own I/O deadline;
        // new data traffic cannot starve disposal. No thread or blocked request
        // lock is needed in Drop, and overload never kills unrelated sessions.
        if self.opened { self.process.close(self.session.clone()); }
    }
}

#[derive(Deserialize)]
pub(super) struct Saved {
    views: Vec<(Option<u8>, Value)>,
    replay: String,
    log: Value,
    answers: Value,
    revision: u64,
    over: bool,
    winner: Option<u8>,
    turn: u32,
    first: u8,
}
impl Saved {
    fn snapshot(&self) -> Snapshot {
        Snapshot { views: HashMap::new(), historical_views: self.views.iter().cloned().collect() }
    }
    async fn persist(&self, pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
        // Archive the original exactly once and fence every write by the runtime identity.
        let mut tx = pool.begin().await?;
        archive_original(&mut tx, id, IDENTITY).await?;
        let changed = sqlx::query("UPDATE online_games SET replay=?, log=?, answers=?, revision=?, stage=?, updated_at=? WHERE game_id=? AND EXISTS (SELECT 1 FROM games WHERE id=? AND engine_version=?)")
            .bind(&self.replay).bind(self.log.to_string()).bind(self.answers.to_string())
            .bind(self.revision as i64).bind(if self.over {"over"} else {"live"}).bind(now()).bind(id).bind(id).bind(IDENTITY)
            .execute(&mut *tx).await?.rows_affected();
        ensure!(changed == 1, "saved game identity changed; refusing historical write");
        if self.over {
            sqlx::query("UPDATE games SET status='finished', winner_seat=?, turns=?, ended_at=?, first_seat=? WHERE id=?")
                .bind(self.winner.map(i64::from))
                .bind(i64::from(self.turn))
                .bind(now())
                .bind(i64::from(self.first))
                .bind(id)
                .execute(&mut *tx)
                .await?;
            if let Some((_, view)) = self.views.iter().find(|(seat, _)| seat.is_none()) {
                for p in view["players"].as_array().context("historical players missing")? {
                    sqlx::query("UPDATE game_seats SET final_life=? WHERE game_id=? AND seat=?")
                        .bind(p["life"].as_i64().context("historical life missing")?)
                        .bind(id)
                        .bind(p["seat"].as_i64().context("historical seat missing")?)
                        .execute(&mut *tx)
                        .await?;
                }
            }
        }
        tx.commit().await?;
        Ok(())
    }
}

pub(super) async fn archive_original(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, id: &str, identity: &str) -> anyhow::Result<()> {
    sqlx::query("INSERT OR IGNORE INTO online_game_originals(game_id, engine_version, replay, log, answers, revision, stage, saved_at) SELECT o.game_id,g.engine_version,o.replay,o.log,o.answers,o.revision,o.stage,? FROM online_games o JOIN games g ON g.id=o.game_id WHERE o.game_id=? AND g.engine_version=? AND o.replay IS NOT NULL AND NOT EXISTS (SELECT 1 FROM online_game_originals a WHERE a.game_id=o.game_id)")
        .bind(now()).bind(id).bind(identity).execute(&mut **tx).await?;
    Ok(())
}

fn request(cmd: Cmd) -> Option<(Value, Option<oneshot::Sender<Result<(), String>>>)> {
    let (v, reply) = match cmd {
        Cmd::Choose { seat, revision, index, reply } => {
            (json!({"type":"choose","seat":seat,"revision":revision,"index":index}), Some(reply))
        }
        Cmd::Attack { seat, revision, attacks, reply } => {
            (json!({"type":"attack","seat":seat,"revision":revision,"attacks":attacks}), Some(reply))
        }
        Cmd::Block { seat, revision, blocks, reply } => {
            (json!({"type":"block","seat":seat,"revision":revision,"blocks":blocks}), Some(reply))
        }
        Cmd::Act { seat, revision, action, reply } => (json!({"type":"act","seat":seat,"revision":revision,"action":action}), Some(reply)),
        Cmd::Passing { seat, revision, mode, reply } => (json!({"type":"pass","seat":seat,"revision":revision,"mode":mode}), Some(reply)),
        Cmd::Concede { seat } => (json!({"type":"concede","seat":seat}), None),
        Cmd::Prefs { seat, prefs } => {
            (json!({"type":"prefs","seat":seat,"stops":prefs.stops,"full_control":prefs.full_control,"tap_mana":prefs.tap_mana}), None)
        }
        Cmd::FullControl { seat, on } => (json!({"type":"full_control","seat":seat,"on":on}), None),
        Cmd::Stops { seat, stops } => (json!({"type":"stops","seat":seat,"stops":stops}), None),
        Cmd::Hold { seat, on } => (json!({"type":"hold","seat":seat,"on":on}), None),
        // Historical runtimes retain their original wire schema. The current
        // Phase board is rejected by the authenticated route before this point.
        Cmd::Preview { .. } | Cmd::Board { .. } | Cmd::BoardOpen { .. } | Cmd::BoardClosed { .. } | Cmd::Stop => return None,
    };
    let mut v = v;
    v["op"] = json!("command");
    Some((v, reply))
}

impl PlayHub {
    pub(super) fn spawn_historical(
        self: &Arc<Self>,
        id: String,
        worker: Worker,
        saved: Saved,
        prefs: HashMap<u8, PlayPrefs>,
        pool: SqlitePool,
    ) {
        let (tx, rx) = std::sync::mpsc::channel();
        let (views, reader) = watch::channel(Arc::new(saved.snapshot()));
        self.live.lock().unwrap().insert(
            id.clone(),
            LiveGame {
                cmds: tx,
                views: reader,
            },
        );
        let hub = self.clone();
        let rt = tokio::runtime::Handle::current();
        std::thread::Builder::new()
            .name("historical-game".into())
            .stack_size(STACK)
            .spawn(move || {
                let result = run(&id, worker, saved, prefs, rx, views, &pool, &rt);
                if let Err(e) = result {
                    tracing::error!(game_id=%id,error=%e,"historical game paused; saved record preserved");
                    hub.unavailable
                        .lock()
                        .unwrap()
                        .insert(id.clone(), "The historical runtime stopped. This game is preserved; restart recovery is required.".into());
                }
                hub.live.lock().unwrap().remove(&id);
            })
            .expect("historical game thread");
    }
}
#[allow(clippy::too_many_arguments)]
fn run(
    id: &str,
    mut worker: Worker,
    mut saved: Saved,
    prefs: HashMap<u8, PlayPrefs>,
    rx: std::sync::mpsc::Receiver<Cmd>,
    views: watch::Sender<Arc<Snapshot>>,
    pool: &SqlitePool,
    rt: &tokio::runtime::Handle,
) -> anyhow::Result<()> {
    let mut deferred: VecDeque<(Value, bool)> = prefs.into_iter()
        .map(|(seat, prefs)| (request(Cmd::Prefs { seat, prefs }).unwrap().0, false)).collect();
    // A command's hint can add work, but only a settled/faulted batch clears
    // outstanding work. Settings and rejections do not cancel a Busy retry.
    let mut advance = true;
    loop {
        let _ = views.send(Arc::new(saved.snapshot()));
        if saved.over {
            rt.block_on(saved.persist(pool, id))?;
            return Ok(());
        }
        if let Some((value, persist)) = deferred.front() {
            match worker.call(value.clone()) {
                Ok(v) => {
                    saved = serde_json::from_value(v["state"].clone())?;
                    if *persist {
                        rt.block_on(saved.persist(pool, id))?;
                        advance |= v["advance"].as_bool().unwrap_or(false);
                    }
                    deferred.pop_front();
                }
                Err(e) if e.is::<Busy>() => {},
                Err(e) if e.is::<Rejected>() => {
                    tracing::warn!(game_id=id,error=%e,"historical command rejected");
                    deferred.pop_front();
                }
                Err(e) => return Err(e),
            }
        }
        while deferred.is_empty() && advance && !saved.over {
            let v = match worker.call(json!({"op":"batch"})) {
                Ok(v) => v,
                Err(e) if e.is::<Busy>() => break, // retain board/receiver and retry after yielding
                Err(e) => return Err(e),
            };
            saved = serde_json::from_value(v["state"].clone())?;
            if v["moved"].as_u64().unwrap_or(0) > 0 {
                rt.block_on(saved.persist(pool, id))?;
                let _ = views.send(Arc::new(saved.snapshot()));
            }
            if !v["fault"].is_null() {
                let _ = views.send(Arc::new(saved.snapshot()));
                tracing::error!(game_id=id, fault=%v["fault"], "historical AI driver fault; game paused");
                advance = false;
                break;
            }
            advance = !v["settled"].as_bool().unwrap_or(true);
        }
        let _ = views.send(Arc::new(saved.snapshot()));
        if saved.over { continue; }
        let interval = if advance || !deferred.is_empty() { Duration::from_millis(50) } else { Duration::from_secs(1) };
        let cmd = match rx.recv_timeout(interval) {
            Ok(cmd) => cmd,
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                ensure!(worker.process.alive.load(Ordering::SeqCst), "historical runtime stopped; restart recovery is required");
                continue;
            }
        };
        if matches!(cmd, Cmd::Stop) { return Ok(()); }
        if let Cmd::Preview { seat, object, reply } = cmd {
            match worker.call(json!({"op":"preview","seat":seat,"object":object})) {
                Ok(v) => { let _ = reply.send(Ok(serde_json::from_value(v["sources"].clone())?)); },
                Err(e) => {
                    let _ = reply.send(Err(e.to_string()));
                    if !e.is::<Busy>() && !e.is::<Rejected>() { return Err(e); }
                }
            }
            continue;
        }
        let (v, reply) = request(cmd).unwrap();
        // Keep fire-and-forget commands (notably concede) in order until admitted.
        // Commands with a reply get an explicit retry, never a later surprise execution.
        if !deferred.is_empty() {
            if let Some(reply) = reply { let _ = reply.send(Err(Busy.to_string())); }
            else { deferred.push_back((v, true)); }
            continue;
        }
        match worker.call(v.clone()) {
            Ok(v) => {
                saved = serde_json::from_value(v["state"].clone())?;
                rt.block_on(saved.persist(pool, id))?;
                advance |= v["advance"].as_bool().unwrap_or(false);
                if let Some(reply) = reply { let _ = reply.send(Ok(())); }
            }
            Err(e) => {
                if let Some(reply) = reply { let _ = reply.send(Err(e.to_string())); }
                else if e.is::<Busy>() { deferred.push_back((v, true)); }
                if e.is::<Busy>() { continue; }
                if !e.is::<Rejected>() { return Err(e); }
            }
        }
    }
}

/// Historical boards stay in their original wire schema. Only names already visible to this
/// viewer are looked up; current engine types never deserialize historical decisions/actions.
pub(super) async fn view_message(
    pool: &SqlitePool,
    mut view: Value,
    you: Option<u8>,
    infos: &Value,
    cache: &mut HashMap<String, Option<CardMeta>>,
) -> Value {
    fn names(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::Object(map) => {
                for (k, v) in map {
                    if (k == "name" || k == "under") && v.is_string() {
                        out.push(v.as_str().unwrap().into());
                    } else {
                        names(v, out);
                    }
                }
            }
            Value::Array(a) => {
                for v in a {
                    names(v, out);
                }
            }
            _ => {}
        }
    }
    let mut visible = vec![];
    names(&view, &mut visible);
    visible.sort();
    visible.dedup();
    let cards = card_meta(pool, &visible, cache).await;
    if let Some(p) = view.pointer_mut("/decision/pending").and_then(Value::as_object_mut) {
        if let Some(src) = p.get_mut("source").and_then(Value::as_object_mut) {
            if let Some(meta) = src.get("name").and_then(Value::as_str).and_then(|n| cards.get(n)) {
                src.insert("image".into(), json!(meta.image));
                src.insert("art".into(), json!(meta.art));
                src.insert("artist".into(), json!(meta.artist));
                p.insert("oracle".into(), json!(meta.oracle_text));
            }
        }
        for key in ["options", "shown"] {
            if let Some(options) = p.get_mut(key).and_then(Value::as_array_mut) {
                for option in options {
                    if option["card"] != true {
                        continue;
                    }
                    if let Some(meta) = option["name"].as_str().and_then(|n| cards.get(n)) {
                        option["img"] = json!(meta.image);
                        option["art"] = json!(meta.art);
                        option["artist"] = json!(meta.artist);
                    }
                }
            }
        }
    }
    json!({"type":"view","you":you,"seats":infos,"cards":cards,"view":view})
}

#[cfg(test)]
mod phase_board_tests {
    use super::*;

    #[tokio::test]
    async fn current_phase_commands_are_not_forwarded_to_the_historical_runtime() {
        let (reply, response) = oneshot::channel();
        assert!(request(Cmd::Board {
            seat: 0,
            mv: board::Move::Action(yama_play::board::GameAction::PassPriority),
            reply,
        }).is_none());
        assert!(response.await.is_err());
        let (reply, response) = oneshot::channel();
        assert!(request(Cmd::BoardOpen { viewer: Some(0), reply }).is_none());
        assert!(response.await.is_err());
        assert!(request(Cmd::BoardClosed { viewer: Some(0) }).is_none());
    }
}

#[cfg(test)]
mod supervision_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Instant;

    fn script(body: &str) -> (tempfile::TempDir, Config) {
        use sha2::{Digest, Sha256};
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("runtime");
        std::fs::write(&binary, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = Config::new(binary.clone(), dir.path().join("data"));
        // Leave room for process/thread startup while the full server suite runs in parallel.
        config.deadline = Duration::from_secs(1);
        std::fs::write(
            &config.digest,
            format!(
                "{}  {}\n",
                Sha256::digest(std::fs::read(&binary).unwrap()).iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
                binary.display()
            ),
        )
        .unwrap();
        (dir, config)
    }
    fn hello() -> String {
        format!(
            "printf '%s\\n' '{}'",
            json!({"hello":serde_json::from_str::<Value>(MANIFEST).unwrap(),"source":serde_json::from_str::<Value>(SOURCE).unwrap()})
        )
    }
    fn assert_reaped(process: &Process) {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(2) {
            if let Ok(mut child) = process.child.try_lock() {
                if child.try_wait().unwrap().is_some() {
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("supervisor did not kill and reap the hung child");
    }
    #[test]
    fn hung_greeting_is_bounded_and_failure_is_cached() {
        let (_dir, config) = script("exec /bin/sleep 30");
        let start = Instant::now();
        assert!(Worker::start(&config).is_err());
        assert!(Worker::start(&config).is_err());
        assert!(start.elapsed() < Duration::from_secs(5));
    }
    #[test]
    fn hung_request_invalidates_shared_sessions_and_drop_never_waits_on_io() {
        let (_dir, config) = script(&format!("{}\nexec /bin/sleep 30", hello()));
        let mut first = Worker::start(&config).unwrap();
        let mut second = Worker::start(&config).unwrap();
        assert_eq!(first.process_id(), second.process_id());
        let start = Instant::now();
        assert!(first.call(json!({"op":"view"})).is_err());
        assert!(second.call(json!({"op":"view"})).is_err());
        assert!(Worker::start(&config).is_err());
        assert_reaped(&first.process);
        drop(first);
        drop(second);
        assert!(start.elapsed() < Duration::from_secs(5));
    }
    #[test]
    fn hung_close_is_supervised_even_without_another_request() {
        let (_dir, mut config) = script(&format!("{}\nexec /bin/sleep 30", hello()));
        config.deadline = Duration::from_secs(1);
        let mut first = Worker::start(&config).unwrap();
        first.opened = true; // fixture models a session already accepted before close hangs
        let second = Worker::start(&config).unwrap();
        let start = Instant::now();
        drop(first);
        assert!(start.elapsed() < Duration::from_millis(250));
        while second.process.alive.load(Ordering::SeqCst)
            && start.elapsed() < Duration::from_secs(2)
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!second.process.alive.load(Ordering::SeqCst));
        assert_reaped(&second.process);
    }
    #[test]
    fn rejected_close_cannot_leak_a_session_in_the_shared_process() {
        let (_dir, config) = script(&format!(
            "{}\nwhile IFS= read -r request; do printf '%s\\n' '{{\"error\":\"close rejected\"}}'; done",
            hello()
        ));
        let mut first = Worker::start(&config).unwrap();
        first.opened = true; // fixture models a session whose close is rejected
        let second = Worker::start(&config).unwrap();
        drop(first);
        assert_reaped(&second.process);
        assert!(!second.process.alive.load(Ordering::SeqCst));
    }
    #[test]
    fn queued_deadline_cancels_before_dispatch_without_killing_active_io() {
        let audit = tempfile::NamedTempFile::new().unwrap();
        let (_dir, mut config) = script(&format!(
            "{}\nwhile IFS= read -r request; do printf '%s\\n' \"$request\" >> '{}'; case \"$request\" in *hold*) /bin/sleep 0.2 ;; esac; printf '%s\\n' \"$request\"; done",
            hello(), audit.path().display()
        ));
        config.deadline = Duration::from_secs(2);
        config.queue_deadline = Duration::from_millis(50);
        let process = Arc::new(Process::start(&config).unwrap());
        let first = process.submit(json!({"op":"hold"})).unwrap();
        assert!(matches!(first.response.recv_timeout(Duration::from_secs(1)).unwrap(), Response::Started(_)));
        let error = process.call(json!({"op":"must-not-execute"})).unwrap_err();
        assert!(error.is::<Busy>(), "{error:#}");
        assert!(process.alive.load(Ordering::SeqCst));
        assert!(matches!(first.response.recv_timeout(Duration::from_secs(1)).unwrap(), Response::Finished(Ok(_))));
        let response = process.call(json!({"op":"after"})).unwrap();
        assert_eq!(response["op"], "after");
        assert!(!std::fs::read_to_string(audit.path()).unwrap().contains("must-not-execute"));
        assert!(process.alive.load(Ordering::SeqCst));
    }
    #[test]
    fn active_deadline_starts_at_dispatch_not_queue_admission() {
        let (_dir, mut config) = script(&format!(
            "{}\nwhile IFS= read -r request; do /bin/sleep 0.6; printf '%s\\n' \"$request\"; done", hello()
        ));
        config.deadline = Duration::from_secs(1);
        config.queue_deadline = Duration::from_secs(2);
        let process = Arc::new(Process::start(&config).unwrap());
        let first = process.submit(json!({"op":"first"})).unwrap();
        assert!(matches!(first.response.recv_timeout(Duration::from_secs(1)).unwrap(), Response::Started(_)));
        let response = process.call(json!({"op":"second"})).unwrap();
        assert_eq!(response["op"], "second");
        assert!(process.alive.load(Ordering::SeqCst));
    }
    #[test]
    fn same_greeting_cannot_authenticate_a_different_executable() {
        let (_dir, config) = script(&hello());
        let original = std::fs::read_to_string(&config.binary).unwrap();
        std::fs::write(
            &config.binary,
            format!("{original}\n# replaced executable\n"),
        )
        .unwrap();
        let error = Worker::start(&config).err().unwrap();
        assert!(error.to_string().contains("executable provenance mismatch"));
    }
    #[test]
    fn bound_executable_with_wrong_export_greeting_is_rejected() {
        let hello = json!({"hello":serde_json::from_str::<Value>(MANIFEST).unwrap(),"source":{"source_sha256":"altered"}});
        let (_dir, config) = script(&format!("printf '%s\\n' '{hello}'"));
        let error = Worker::start(&config).err().unwrap();
        assert!(error.to_string().contains("provenance mismatch"), "{error:#}");
    }
}
