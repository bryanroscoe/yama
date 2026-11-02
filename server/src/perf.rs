//! Finding slowness (2026-11-02; deploy/README.md, "Finding slowness"): how long requests, SQL
//! statements and background jobs take, in the log and in a small summary for Admin, Server.
//!
//! Nothing here keeps a raw path, query string, bound value or account. A request is its method
//! and the route it matched (`/api/decks/{id}`, never `/api/decks/8c1f…?token=…`), a statement is
//! its SQL text, whose values are always bound (`?`), and a job is its name and a count or kind.
//! Everything is in memory and bounded: an hour of timings per route, the last 200 of each list.

use axum::extract::{MatchedPath, Request};
use axum::http::{Method, header};
use axum::middleware::Next;
use axum::response::Response;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tracing::field::{Field, Visit};
use tracing_subscriber::field::{MakeVisitor, VisitFmt, VisitOutput};
use tracing_subscriber::fmt::format::{DefaultVisitor, Writer};

/// The rolling window the route figures cover.
const WINDOW: Duration = Duration::from_secs(60 * 60);
/// Timings kept per route within the window (the newest).
const SAMPLES: usize = 1_000;
/// Routes tracked. Routes are templates, so there are a few hundred at most; past this the rest
/// count together, so nothing a client sends can grow the table.
const ROUTES: usize = 400;
/// Entries kept in each list of slow requests, slow statements and job runs.
const RECENT: usize = 200;
/// SQL text longer than this is cut, in the log and in the summary.
pub const SQL_CHARS: usize = 300;

/// Default for YAMA_SLOW_REQUEST_MS.
pub const SLOW_REQUEST_MS: u64 = 500;
/// Default for YAMA_SLOW_QUERY_MS.
pub const SLOW_QUERY_MS: u64 = 200;

static SLOW_REQUEST: AtomicU64 = AtomicU64::new(SLOW_REQUEST_MS);
static SLOW_QUERY: AtomicU64 = AtomicU64::new(SLOW_QUERY_MS);

/// Set the thresholds from the configuration (once, at startup).
pub fn configure(slow_request_ms: u64, slow_query_ms: u64) {
    SLOW_REQUEST.store(slow_request_ms, Ordering::Relaxed);
    SLOW_QUERY.store(slow_query_ms, Ordering::Relaxed);
}

#[derive(Default)]
struct Store {
    routes: HashMap<(&'static str, String), Route>,
    requests: VecDeque<SlowRequest>,
    statements: VecDeque<SlowStatement>,
    jobs: VecDeque<JobRun>,
}

#[derive(Default)]
struct Route {
    /// Every request since the server started.
    total: u64,
    /// When each recent request finished, and how long it took in milliseconds.
    samples: VecDeque<(Instant, f64)>,
}

#[derive(Serialize, Clone)]
pub struct SlowRequest {
    at: String,
    method: &'static str,
    route: String,
    status: u16,
    ms: f64,
}

#[derive(Serialize, Clone)]
pub struct SlowStatement {
    at: String,
    ms: f64,
    rows: u64,
    sql: String,
}

#[derive(Serialize, Clone)]
pub struct JobRun {
    at: String,
    job: &'static str,
    ms: f64,
    ok: bool,
    slow: bool,
    note: String,
}

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(Mutex::default);

fn store() -> MutexGuard<'static, Store> {
    STORE.lock().unwrap_or_else(|e| e.into_inner())
}

/// A list newest first.
fn newest<T: Clone>(list: &VecDeque<T>) -> Vec<T> {
    list.iter().rev().cloned().collect()
}

fn push<T>(list: &mut VecDeque<T>, item: T) {
    if list.len() >= RECENT {
        list.pop_front();
    }
    list.push_back(item);
}

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 10_000.0).round() / 10.0
}

// ── requests ───────────────────────────────────────────────────────────────

fn method(m: &Method) -> &'static str {
    match *m {
        Method::GET => "GET",
        Method::POST => "POST",
        Method::PUT => "PUT",
        Method::PATCH => "PATCH",
        Method::DELETE => "DELETE",
        Method::HEAD => "HEAD",
        Method::OPTIONS => "OPTIONS",
        _ => "OTHER",
    }
}

/// The route template a request matched. Requests no route matched are the web app's files and
/// phase's board (a nested service, which axum gives no matched path); they're named, not shown.
fn route(req: &Request) -> String {
    match req.extensions().get::<MatchedPath>() {
        Some(p) => p.as_str().to_string(),
        None if req.uri().path() == "/board" || req.uri().path().starts_with("/board/") => "/board/{*file}".into(),
        None => "(web app files)".into(),
    }
}

/// A WebSocket upgrade answers once the handshake is done; the socket's life isn't the request's.
fn is_upgrade(req: &Request) -> bool {
    req.headers().get(header::UPGRADE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

/// Middleware: time every request to its answer (the headers; a streamed body may go on), log it,
/// and add it to the summary. A request whose client goes away before the answer is counted
/// with status 499, as nginx does.
pub async fn track(req: Request, next: Next) -> Response {
    let mut timing = Timing { method: method(req.method()), route: route(&req), upgrade: is_upgrade(&req), started: Instant::now(), done: false };
    let res = next.run(req).await;
    timing.finish(res.status().as_u16());
    res
}

struct Timing {
    method: &'static str,
    route: String,
    upgrade: bool,
    started: Instant,
    done: bool,
}

impl Timing {
    fn finish(&mut self, status: u16) {
        self.done = true;
        let took = self.started.elapsed();
        let slow = took >= Duration::from_millis(SLOW_REQUEST.load(Ordering::Relaxed));
        let (method, route, ms) = (self.method, self.route.as_str(), ms(took));
        if slow {
            tracing::warn!(method, route, status, ms, websocket = self.upgrade, "slow request");
        } else {
            tracing::debug!(method, route, status, ms, websocket = self.upgrade, "request");
        }
        record_request(method, std::mem::take(&mut self.route), status, took, slow);
    }
}

impl Drop for Timing {
    fn drop(&mut self) {
        if !self.done {
            self.finish(499);
        }
    }
}

fn record_request(method: &'static str, route: String, status: u16, took: Duration, slow: bool) {
    store().request(method, route, status, took, slow)
}

impl Store {
    fn request(&mut self, method: &'static str, route: String, status: u16, took: Duration, slow: bool) {
        let ms = ms(took);
        let key = (method, route);
        let key = if self.routes.len() < ROUTES || self.routes.contains_key(&key) { key } else { ("OTHER", "(other routes)".into()) };
        let r = self.routes.entry(key.clone()).or_default();
        r.total += 1;
        if r.samples.len() >= SAMPLES {
            r.samples.pop_front();
        }
        r.samples.push_back((Instant::now(), ms));
        if slow {
            push(&mut self.requests, SlowRequest { at: crate::util::now(), method: key.0, route: key.1, status, ms });
        }
    }
}

// ── statements ─────────────────────────────────────────────────────────────

/// SQL on one line, cut to [`SQL_CHARS`].
pub fn short_sql(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len().min(SQL_CHARS + 4));
    for (i, word) in sql.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(word);
        if out.chars().count() > SQL_CHARS {
            let cut: String = out.chars().take(SQL_CHARS).collect();
            return format!("{cut}…");
        }
    }
    out
}

/// A tracing layer that copies sqlx's slow-statement warnings (`log_slow_statements`, set in
/// `db.rs`) into the summary. sqlx only ever logs a statement's SQL text, not its bound values.
pub struct SlowStatements;

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for SlowStatements {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        let meta = event.metadata();
        if meta.target() != "sqlx::query" || *meta.level() != tracing::Level::WARN {
            return;
        }
        let mut f = StatementFields::default();
        event.record(&mut f);
        let sql = if f.statement.trim().is_empty() { &f.summary } else { &f.statement };
        let s = SlowStatement { at: crate::util::now(), ms: ms(Duration::from_secs_f64(f.elapsed_secs.max(0.0))), rows: f.rows_returned.max(f.rows_affected), sql: short_sql(sql) };
        push(&mut store().statements, s);
    }
}

#[derive(Default)]
struct StatementFields {
    summary: String,
    statement: String,
    elapsed_secs: f64,
    rows_returned: u64,
    rows_affected: u64,
}

impl Visit for StatementFields {
    fn record_str(&mut self, field: &Field, value: &str) {
        match field.name() {
            "summary" => self.summary = value.to_string(),
            "db.statement" => self.statement = value.to_string(),
            _ => {}
        }
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        if field.name() == "elapsed_secs" {
            self.elapsed_secs = value;
        }
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        match field.name() {
            "rows_returned" => self.rows_returned = value,
            "rows_affected" => self.rows_affected = value,
            _ => {}
        }
    }
    fn record_debug(&mut self, _: &Field, _: &dyn fmt::Debug) {}
}

/// The log's field formatter: tracing's own, except that sqlx's `db.statement` (a statement's
/// whole SQL, which can run to pages) is put on one line and cut to [`SQL_CHARS`].
pub struct LogFields;

impl<'a> MakeVisitor<Writer<'a>> for LogFields {
    type Visitor = ShortStatements<'a>;

    fn make_visitor(&self, target: Writer<'a>) -> Self::Visitor {
        ShortStatements(DefaultVisitor::new(target, true))
    }
}

pub struct ShortStatements<'a>(DefaultVisitor<'a>);

impl Visit for ShortStatements<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "db.statement" {
            self.0.record_str(field, &short_sql(value))
        } else {
            self.0.record_str(field, value)
        }
    }
    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.0.record_error(field, value)
    }
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.0.record_debug(field, value)
    }
}

impl VisitOutput<fmt::Result> for ShortStatements<'_> {
    fn finish(self) -> fmt::Result {
        self.0.finish()
    }
}

impl VisitFmt for ShortStatements<'_> {
    fn writer(&mut self) -> &mut dyn fmt::Write {
        self.0.writer()
    }
}

// ── background jobs ────────────────────────────────────────────────────────

/// A background job's timing. `let job = Job::start("Scryfall import", Duration::from_secs(900));`
/// then `job.done(ok, note)`: one info line with the duration, a warning instead when it failed
/// or took longer than `slow_after`. The note is a count or a kind, never anyone's data. A job
/// dropped before that (an early `?`) is recorded as failed.
pub struct Job {
    name: &'static str,
    started: Instant,
    slow_after: Duration,
    frequent: bool,
    ended: bool,
}

impl Job {
    pub fn start(name: &'static str, slow_after: Duration) -> Self {
        Self { name, started: Instant::now(), slow_after, frequent: false, ended: false }
    }

    /// A job that runs many times a minute (a lab game's result): its normal runs are debug lines
    /// and stay out of the summary, so they don't push out the rest; slow or failed runs show.
    pub fn frequent(name: &'static str, slow_after: Duration) -> Self {
        let mut job = Self::start(name, slow_after);
        job.frequent = true;
        job
    }

    pub fn done(mut self, ok: bool, note: impl Into<String>) -> Duration {
        self.end(ok, note.into())
    }

    /// [`Job::done`] from a result: ok unless it's an error.
    pub fn finish<T, E>(self, result: &Result<T, E>, note: impl Into<String>) -> Duration {
        self.done(result.is_ok(), note)
    }

    fn end(&mut self, ok: bool, note: String) -> Duration {
        self.ended = true;
        let took = self.started.elapsed();
        let slow = took >= self.slow_after;
        let (job, ms) = (self.name, ms(took));
        let slow_after_ms = self.slow_after.as_millis() as u64;
        match (ok, slow, self.frequent) {
            (false, ..) => tracing::warn!(job, ms, note, "job failed"),
            (true, true, _) => tracing::warn!(job, ms, note, slow_after_ms, "slow job"),
            (true, false, false) => tracing::info!(job, ms, note, "job finished"),
            (true, false, true) => tracing::debug!(job, ms, note, "job finished"),
        }
        if !self.frequent || !ok || slow {
            push(&mut store().jobs, JobRun { at: crate::util::now(), job, ms, ok, slow, note });
        }
        took
    }
}

/// A job dropped without [`Job::done`] ended early: an error returned before it was timed, or its
/// task was cancelled. It counts as failed.
impl Drop for Job {
    fn drop(&mut self) {
        if !self.ended {
            self.end(false, "stopped before it finished".into());
        }
    }
}

// ── the summary ────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct RouteSummary {
    method: &'static str,
    route: String,
    /// Requests in the window (up to the newest 1,000).
    count: usize,
    /// Requests since the server started.
    total: u64,
    p50_ms: f64,
    p95_ms: f64,
    max_ms: f64,
}

#[derive(Serialize)]
pub struct Summary {
    window_minutes: u64,
    slow_request_ms: u64,
    slow_query_ms: u64,
    /// Slowest first (by p95).
    routes: Vec<RouteSummary>,
    /// Newest first.
    slow_requests: Vec<SlowRequest>,
    slow_statements: Vec<SlowStatement>,
    jobs: Vec<JobRun>,
}

/// The value at quantile `q` of sorted `xs` (nearest rank).
fn quantile(xs: &[f64], q: f64) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    let rank = (q * xs.len() as f64).ceil() as usize;
    xs[rank.clamp(1, xs.len()) - 1]
}

pub fn summary() -> Summary {
    let cutoff = Instant::now().checked_sub(WINDOW);
    let mut s = store();
    let mut routes: Vec<RouteSummary> = s
        .routes
        .iter_mut()
        .filter_map(|((method, route), r)| {
            if let Some(cut) = cutoff {
                while r.samples.front().is_some_and(|(at, _)| *at < cut) {
                    r.samples.pop_front();
                }
            }
            if r.samples.is_empty() {
                return None;
            }
            let mut xs: Vec<f64> = r.samples.iter().map(|(_, ms)| *ms).collect();
            xs.sort_by(f64::total_cmp);
            Some(RouteSummary {
                method,
                route: route.clone(),
                count: xs.len(),
                total: r.total,
                p50_ms: quantile(&xs, 0.5),
                p95_ms: quantile(&xs, 0.95),
                max_ms: *xs.last().unwrap_or(&0.0),
            })
        })
        .collect();
    routes.sort_by(|a, b| b.p95_ms.total_cmp(&a.p95_ms).then(b.count.cmp(&a.count)).then(a.route.cmp(&b.route)));
    Summary {
        window_minutes: WINDOW.as_secs() / 60,
        slow_request_ms: SLOW_REQUEST.load(Ordering::Relaxed),
        slow_query_ms: SLOW_QUERY.load(Ordering::Relaxed),
        routes,
        slow_requests: newest(&s.requests),
        slow_statements: newest(&s.statements),
        jobs: newest(&s.jobs),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_is_one_line_and_cut() {
        assert_eq!(short_sql("\n\nSELECT a,\n       b\n  FROM t WHERE x = ?\n"), "SELECT a, b FROM t WHERE x = ?");
        let long = format!("SELECT {} FROM t", vec!["column_name"; 100].join(", "));
        let cut = short_sql(&long);
        assert_eq!(cut.chars().count(), SQL_CHARS + 1);
        assert!(cut.ends_with('…'));
        // Never cut inside a character.
        assert!(short_sql(&"é ".repeat(400)).ends_with('…'));
    }

    #[test]
    fn quantiles_are_nearest_rank() {
        let xs: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(quantile(&xs, 0.5), 50.0);
        assert_eq!(quantile(&xs, 0.95), 95.0);
        assert_eq!(quantile(&[7.0], 0.95), 7.0);
        assert_eq!(quantile(&[], 0.5), 0.0);
    }

    #[test]
    fn unknown_methods_and_routes_cant_grow_the_table() {
        assert_eq!(method(&Method::from_bytes(b"BREW").unwrap()), "OTHER");
        let mut s = Store::default();
        for i in 0..ROUTES + 50 {
            s.request("GET", format!("/test/route-{i}"), 200, Duration::from_millis(1), false);
        }
        assert_eq!(s.routes.len(), ROUTES + 1);
        assert_eq!(s.routes[&("OTHER", "(other routes)".to_string())].total, 50);
    }

    #[test]
    fn frequent_jobs_show_only_when_slow_or_failed() {
        Job::frequent("test quick", Duration::from_secs(60)).done(true, "1 game");
        Job::frequent("test failed", Duration::from_secs(60)).done(false, "1 game");
        Job::frequent("test slow", Duration::ZERO).done(true, "1 game");
        Job::start("test daily", Duration::from_secs(60)).done(true, "3 tables");
        // An early return drops a job unfinished: it counts as failed.
        drop(Job::frequent("test dropped", Duration::from_secs(60)));
        let jobs: Vec<&str> = store().jobs.iter().map(|j| j.job).filter(|j| j.starts_with("test ")).collect();
        assert!(!jobs.contains(&"test quick"));
        for j in ["test failed", "test slow", "test daily", "test dropped"] {
            assert!(jobs.contains(&j), "{j}");
        }
    }
}
