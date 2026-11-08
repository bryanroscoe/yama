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
//! Request bodies are never logged.

use axum::extract::Request;
use axum::http::{Extensions, Method};
use axum::middleware::Next;
use axum::response::Response;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

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

/// Middleware: one log line per write request, after it is answered.
pub async fn log_writes(mut req: Request, next: Next) -> Response {
    if !is_write(req.method()) {
        return next.run(req).await;
    }
    let who = Who::default();
    req.extensions_mut().insert(who.clone());
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let started = Instant::now();
    let res = next.run(req).await;
    tracing::info!(
        target: TARGET,
        method = %method,
        path = %path,
        status = res.status().as_u16(),
        ms = started.elapsed().as_millis() as u64,
        user = who.get().unwrap_or("-"),
        "write"
    );
    res
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
    fn daily_files_go_in_the_folder() {
        let dir = std::env::temp_dir().join(format!("yama-log-test-{}", crate::util::new_id()));
        let appender = file_appender(&dir, 3).expect("a writable folder");
        let (writer, guard) = tracing_appender::non_blocking::NonBlockingBuilder::default().lossy(false).finish(appender);
        let subscriber = tracing_subscriber::registry().with(tracing_subscriber::fmt::layer().with_ansi(false).with_writer(writer));
        tracing::subscriber::with_default(subscriber, || tracing::info!(target: TARGET, "hello"));
        drop(guard);
        let files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).collect();
        let name = files.iter().filter_map(|p| p.file_name()?.to_str().map(String::from)).find(|n| n.starts_with("yama.") && n.ends_with(".log"));
        let name = name.unwrap_or_else(|| panic!("no daily file in {files:?}"));
        assert!(std::fs::read_to_string(dir.join(&name)).unwrap().contains("hello"));
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
}
