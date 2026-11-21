//! "Delete them" against uploads on their way (Codex review of #171).
//!
//! The scanner sends scan photos, scanner diagnostics and their timing records in the background,
//! so one can still be on its way when the person taps "Delete them". Without this its row could
//! arrive after the deletion had returned, and the photo (with its crops) or record would survive.
//! So "Delete them" records when it ran, per account and kind (`scan_clears`), in the transaction
//! that deletes, and an upload that began at or before that moment is refused in the transaction
//! that would have saved it: after its insert, which holds SQLite's write lock, so it reads the
//! newest clear.

use crate::error::{AppError, AppResult};
use sqlx::SqliteConnection;

/// Scan photos (scan_samples.rs).
pub const SAMPLES: &str = "samples";
/// Scanner diagnostics and their timing records (scan_diagnostics.rs, scan_timings.rs).
pub const DIAGNOSTICS: &str = "diagnostics";

/// Now, to the millisecond, in a form that orders as text.
pub fn stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// "Delete them" ran for this account's `kind` at `at`: inside the transaction that deletes.
pub async fn mark(conn: &mut SqliteConnection, owner: &str, kind: &str, at: &str) -> AppResult<()> {
    sqlx::query("INSERT INTO scan_clears (owner_id, kind, cleared_at) VALUES (?, ?, ?) ON CONFLICT (owner_id, kind) DO UPDATE SET cleared_at = excluded.cleared_at")
        .bind(owner)
        .bind(kind)
        .bind(at)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Refuse an upload that began at `started` if "Delete them" ran for its kind since (or at the same
/// moment). Call after the upload's insert, in its transaction, which is then rolled back.
pub async fn refuse_if_cleared(conn: &mut SqliteConnection, owner: &str, kind: &str, started: &str) -> AppResult<()> {
    let cleared: Option<String> =
        sqlx::query_scalar("SELECT cleared_at FROM scan_clears WHERE owner_id = ? AND kind = ? AND cleared_at >= ?").bind(owner).bind(kind).bind(started).fetch_optional(&mut *conn).await?;
    match cleared {
        Some(_) => Err(AppError::Conflict("These were deleted while this one was on its way, so it isn't kept.".into())),
        None => Ok(()),
    }
}
