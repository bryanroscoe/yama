//! The server's log kept on the data volume, with one line for every write and command.
//!
//! `docker logs` starts over whenever a deploy recreates the container. On 2026-11-08 Bryan
//! asked what had happened to cards he remembered putting in Yama. After fifteen deploys that
//! day the container log reached back only to the last one, and nothing recorded who had sent
//! which change. Now, with `YAMA_LOG_DIR` set (`/data/logs` in deploy/compose.yaml), everything
//! the server logs also goes to a file there, one file per UTC day (`yama.YYYY-MM-DD.log`),
//! keeping `YAMA_LOG_DAYS` of them (180 by default). Commands run with `docker exec` write to
//! the same files.
//!
//! On top of what was already logged:
//! - **Every write request** (anything but GET, HEAD and OPTIONS): `write method=DELETE
//!   path=/api/collection/items/… status=200 ms=12 user=<account id>`. The path is the one
//!   requested, so it names the deck, box or copy changed. The query string is left out, and no
//!   write route carries a token in its path (share links and their tokens are read-only GETs).
//!   `user` is the account an extractor signed in (`-` when none was asked for, as on sign-in).
//! - **Every command** (`yama-server import-mythic …`): its arguments, with the value after a
//!   password, token, key or secret flag hidden.
//! - **MCP tool calls** say whose they were (`mcp/mod.rs`).
//!
//! Request bodies are never logged, and in the files anything shaped like an email address is
//! written as `[email]` ([`FileFields`]): the files outlive deleted accounts by up to
//! `YAMA_LOG_DAYS`, and an account id or a deck's id matches nothing once it is gone.
//! `docker logs` is unchanged.

use axum::extract::Request;
use axum::http::{Extensions, Method};
use axum::middleware::Next;
use axum::response::Response;
use std::borrow::Cow;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use tracing::field::{Field, Visit};
use tracing_subscriber::field::{MakeVisitor, VisitFmt, VisitOutput};
use tracing_subscriber::fmt::format::Writer;

/// The target of the write and command lines, so they can be picked out (`grep "yama_server::writes"`).
pub const TARGET: &str = "yama_server::writes";

/// Default for YAMA_LOG_DAYS: about six months of daily files.
pub const DEFAULT_DAYS: usize = 180;

/// Who sent a write request, filled in by the extractor that signs them in.
#[derive(Clone, Default)]
pub struct Who(Arc<OnceLock<String>>);

impl Who {
    pub fn get(&self) -> Option<&str> {
        self.0.get().map(String::as_str)
    }
}

/// Record that this request is the account `user_id`'s. Does nothing on a read, which has no slot.
pub fn note_user(extensions: &Extensions, user_id: &str) {
    if let Some(who) = extensions.get::<Who>() {
        let _ = who.0.set(user_id.to_string());
    }
}

fn is_write(method: &Method) -> bool {
    !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

/// Middleware: one log line per write request, once it is answered. A request dropped before
/// that (the client went away, as a phone losing signal mid-sync does, or the handler panicked)
/// still gets its line, with status 499: it may have changed something before it stopped.
pub async fn log_writes(mut req: Request, next: Next) -> Response {
    if !is_write(req.method()) {
        return next.run(req).await;
    }
    let who = Who::default();
    req.extensions_mut().insert(who.clone());
    let mut line = WriteLine { method: req.method().clone(), path: req.uri().path().to_string(), who, started: Instant::now(), done: false };
    let res = next.run(req).await;
    line.finish(res.status().as_u16());
    res
}

struct WriteLine {
    method: Method,
    path: String,
    who: Who,
    started: Instant,
    done: bool,
}

impl WriteLine {
    fn finish(&mut self, status: u16) {
        self.done = true;
        tracing::info!(
            target: TARGET,
            method = %self.method,
            path = %self.path,
            status,
            ms = self.started.elapsed().as_millis() as u64,
            user = %self.who.get().unwrap_or("-"),
            "write"
        );
    }
}

impl Drop for WriteLine {
    fn drop(&mut self) {
        if !self.done {
            self.finish(499);
        }
    }
}

/// A command's arguments for the log, with the value after any password, token, key or secret
/// flag hidden (`user add` reads its password from stdin, but a later command might not).
pub fn command_line(args: &[String]) -> String {
    let mut out = Vec::with_capacity(args.len());
    let mut hide_next = false;
    for a in args {
        if hide_next {
            out.push("[hidden]".to_string());
            hide_next = false;
            continue;
        }
        let lower = a.to_ascii_lowercase();
        let secret = a.starts_with("--") && ["password", "token", "secret", "key"].iter().any(|w| lower.contains(w));
        match a.split_once('=') {
            Some((flag, _)) if secret => out.push(format!("{flag}=[hidden]")),
            _ => {
                out.push(a.clone());
                // `--password-stdin` takes no value.
                hide_next = secret && !lower.ends_with("-stdin");
            }
        }
    }
    out.join(" ")
}

/// The files' field formatter: the log's own ([`crate::perf::LogFields`]), with anything shaped
/// like an email address written as `[email]`.
pub struct FileFields;

impl<'a> MakeVisitor<Writer<'a>> for FileFields {
    type Visitor = HideEmails<crate::perf::ShortStatements<'a>>;

    fn make_visitor(&self, target: Writer<'a>) -> Self::Visitor {
        HideEmails(crate::perf::LogFields.make_visitor(target))
    }
}

pub struct HideEmails<V>(V);

impl<V: Visit> Visit for HideEmails<V> {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.record_str(field, &hide_emails(value))
    }
    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        match hide_emails(&value.to_string()) {
            Cow::Owned(hidden) => self.0.record_debug(field, &format_args!("{hidden}")),
            Cow::Borrowed(_) => self.0.record_error(field, value),
        }
    }
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        match hide_emails(&format!("{value:?}")) {
            Cow::Owned(hidden) => self.0.record_debug(field, &format_args!("{hidden}")),
            Cow::Borrowed(_) => self.0.record_debug(field, value),
        }
    }
}

impl<V: VisitOutput<fmt::Result>> VisitOutput<fmt::Result> for HideEmails<V> {
    fn finish(self) -> fmt::Result {
        self.0.finish()
    }
}

impl<V: VisitFmt> VisitFmt for HideEmails<V> {
    fn writer(&mut self) -> &mut dyn fmt::Write {
        self.0.writer()
    }
}

/// `text` with every run that looks like an email address (`x@y.z`, or `x%40y.z` as a path
/// encodes it: removing an invite is `DELETE /api/invites/friend%40example.com`) replaced by `[email]`.
pub fn hide_emails(text: &str) -> Cow<'_, str> {
    if !text.contains('@') && !text.contains("%40") {
        return Cow::Borrowed(text);
    }
    let part = |c: char| c.is_alphanumeric() || "._%+-@".contains(c);
    let mut out = String::with_capacity(text.len());
    let mut changed = false;
    let mut rest = text;
    while let Some(start) = rest.find(part) {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let end = rest.find(|c: char| !part(c)).unwrap_or(rest.len());
        let word = &rest[..end];
        let is_email = word.replace("%40", "@").split_once('@').is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.'));
        if is_email {
            out.push_str("[email]");
            changed = true;
        } else {
            out.push_str(word);
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    if changed { Cow::Owned(out) } else { Cow::Borrowed(text) }
}

/// Where the log files go and how many days to keep, from the environment.
pub fn settings() -> Option<(PathBuf, usize)> {
    let dir = std::env::var("YAMA_LOG_DIR").ok().filter(|d| !d.trim().is_empty())?;
    let days = std::env::var("YAMA_LOG_DAYS").ok().and_then(|d| d.trim().parse::<usize>().ok()).filter(|d| *d > 0).unwrap_or(DEFAULT_DAYS);
    Some((PathBuf::from(dir), days))
}

/// The daily log files' writer. `None` (with the reason on stderr) when the folder can't be used,
/// so a full or read-only disk never stops the server from starting.
pub fn file_appender(dir: &Path, days: usize) -> Option<tracing_appender::rolling::RollingFileAppender> {
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("YAMA_LOG_DIR {}: can't create it ({e}); logging to stderr only", dir.display());
        return None;
    }
    match tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("yama")
        .filename_suffix("log")
        .max_log_files(days)
        .build(dir)
    {
        Ok(a) => Some(a),
        Err(e) => {
            eprintln!("YAMA_LOG_DIR {}: can't write there ({e}); logging to stderr only", dir.display());
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;
    use axum::http::StatusCode;
    use std::io::Write;
    use std::sync::Mutex;
    use tracing_subscriber::layer::SubscriberExt;

    #[test]
    fn command_line_hides_secret_values() {
        let args = |s: &str| s.split(' ').map(String::from).collect::<Vec<_>>();
        assert_eq!(command_line(&args("import-mythic /data/a.csv --owner a@b.c --dry-run")), "import-mythic /data/a.csv --owner a@b.c --dry-run");
        assert_eq!(command_line(&args("user add a@b.c --password-stdin --admin")), "user add a@b.c --password-stdin --admin");
        assert_eq!(command_line(&args("x --token abc --api-key=def --name n")), "x --token [hidden] --api-key=[hidden] --name n");
    }

    #[test]
    fn emails_are_hidden() {
        assert_eq!(hide_emails("account deleted account=a.b+c@example.com games=3"), "account deleted account=[email] games=3");
        assert_eq!(hide_emails("path=/api/invites/x%40y@mail.example.org"), "path=/api/invites/[email]");
        assert_eq!(hide_emails("\"bob@example.com\""), "\"[email]\"");
        assert_eq!(hide_emails("method=DELETE path=/api/invites/friend%40example.com status=200"), "method=DELETE path=/api/invites/[email] status=200");
        assert!(matches!(hide_emails("no address @ here, nor @handle or user@localhost"), Cow::Borrowed(_)));
    }

    #[test]
    fn daily_files_go_in_the_folder() {
        let dir = std::env::temp_dir().join(format!("yama-log-test-{}", crate::util::new_id()));
        let appender = file_appender(&dir, 3).expect("a writable folder");
        let (writer, guard) = tracing_appender::non_blocking::NonBlockingBuilder::default().lossy(false).finish(appender);
        let subscriber = tracing_subscriber::registry().with(tracing_subscriber::fmt::layer().fmt_fields(FileFields).with_ansi(false).with_writer(writer));
        tracing::subscriber::with_default(subscriber, || tracing::info!(target: TARGET, account = %"someone@example.com", "hello"));
        drop(guard);
        let files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).collect();
        let name = files.iter().filter_map(|p| p.file_name()?.to_str().map(String::from)).find(|n| n.starts_with("yama.") && n.ends_with(".log"));
        let name = name.unwrap_or_else(|| panic!("no daily file in {files:?}"));
        let text = std::fs::read_to_string(dir.join(&name)).unwrap();
        assert!(text.contains("hello") && text.contains("account=[email]") && !text.contains("someone@"), "{text}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);

    impl Write for Buf {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// A write request is logged with its path and the account that sent it; a read isn't.
    #[tokio::test(flavor = "current_thread")]
    async fn writes_are_logged_with_their_account() {
        let (app, pool) = testutil::app().await;
        let (user_id, token) = testutil::user(&pool, "log@example.com").await;
        let buf = Buf::default();
        let writer = buf.clone();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_subscriber::fmt::layer().with_ansi(false).with_writer(move || writer.clone()))
            .with(tracing_subscriber::filter::Targets::new().with_target(TARGET, tracing::Level::INFO));
        let _guard = tracing::subscriber::set_default(subscriber);

        let (status, _) = testutil::send(&app, Method::GET, "/api/decks", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        let (status, body) = testutil::send(&app, Method::POST, "/api/containers", Some(&token), Some(serde_json::json!({"kind": "box", "name": "star trek"}))).await;
        assert!(status.is_success(), "{status} {body}");
        let (status, _) = testutil::send(&app, Method::POST, "/api/containers?secret=1", None, Some(serde_json::json!({"kind": "box", "name": "x"}))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let log = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(lines.len(), 2, "{log}");
        assert!(lines[0].contains("method=POST") && lines[0].contains("path=/api/containers") && lines[0].contains(&format!("user={user_id}")), "{log}");
        assert!(lines[1].contains("status=401") && lines[1].contains("user=-"), "{log}");
        assert!(!log.contains("secret=1") && !log.contains(&token), "{log}");
    }

    /// A write whose request is dropped before it's answered is still logged.
    #[test]
    fn a_dropped_write_is_logged() {
        let buf = Buf::default();
        let writer = buf.clone();
        let subscriber = tracing_subscriber::registry().with(tracing_subscriber::fmt::layer().with_ansi(false).with_writer(move || writer.clone()));
        tracing::subscriber::with_default(subscriber, || {
            let who = Who::default();
            note_user(&{
                let mut e = Extensions::new();
                e.insert(who.clone());
                e
            }, "u1");
            drop(WriteLine { method: Method::DELETE, path: "/api/collection/items/x".into(), who, started: Instant::now(), done: false });
        });
        let log = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        assert!(log.contains("status=499") && log.contains("path=/api/collection/items/x") && log.contains("user=u1"), "{log}");
    }
}
