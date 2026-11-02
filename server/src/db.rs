use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{ConnectOptions, SqlitePool};
use std::str::FromStr;
use std::time::Duration;

/// Each connection's page cache, in KiB (2026-11-02): 32 MB, against SQLite's 2 MB default. Eight
/// connections can hold 256 MB together; the container may use 7 GiB and the server uses ~750 MB.
const CACHE_KIB: u32 = 32 * 1024;
/// Read the file through a memory map, so hot pages come from the OS page cache without a system
/// call or a copy into each connection's cache. 1 GiB covers the whole file (625 MB on 2026-11-02).
/// On saget the data folder is behind Unraid's FUSE layer (`/mnt/user`), where every read is slow:
/// `MAX(date)` over prices took 0.42 s through it and 0.10 s on the cache pool's own path, and
/// 0.08 s through it once the whole file was mapped. The map uses only page cache the reads
/// would fill anyway.
const MMAP_BYTES: u64 = 1024 * 1024 * 1024;
/// The write-ahead log is cut back to this size each time it starts over, so one big import
/// doesn't leave a file that size behind.
const WAL_LIMIT_BYTES: u64 = 64 * 1024 * 1024;

pub async fn connect(url: &str, slow_query: Duration) -> anyhow::Result<SqlitePool> {
    let opts = SqliteConnectOptions::from_str(url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10))
        .pragma("cache_size", format!("-{CACHE_KIB}"))
        .pragma("mmap_size", MMAP_BYTES.to_string())
        .pragma("journal_size_limit", WAL_LIMIT_BYTES.to_string())
        // Statements slower than this are a warning with their SQL text (never their bound
        // values), shortened in the log and kept for Admin, Server (`perf.rs`).
        .log_slow_statements(log::LevelFilter::Warn, slow_query);
    let pool = SqlitePoolOptions::new().max_connections(8).connect_with(opts).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

/// Give SQLite's query planner current table statistics. The database had none at all until
/// 2026-11-02 (no `sqlite_stat1`), so the planner guessed at every table's size. `0x10002` checks
/// every table and analyses the ones never analysed, or ten times bigger or smaller than when they
/// were; when nothing changed it's a quick look. Run at startup, daily and after card imports.
pub async fn optimize(pool: &SqlitePool) {
    let job = crate::perf::Job::start("SQLite optimize", Duration::from_secs(10));
    // The same pragma with the 0x1 bit lists what it would analyse, without doing it.
    let result: sqlx::Result<usize> = async {
        let due: Vec<String> = sqlx::query_scalar("PRAGMA optimize=0x10003").fetch_all(pool).await?;
        if !due.is_empty() {
            sqlx::query("PRAGMA optimize=0x10002").execute(pool).await?;
        }
        Ok(due.len())
    }
    .await;
    match &result {
        Ok(n) => job.done(true, format!("{n} tables analysed")),
        Err(e) => {
            tracing::warn!(error = %e, "couldn't update SQLite's table statistics");
            job.done(false, "")
        }
    };
}

/// Fold the write-ahead log back into the database after a big import and cut the file to
/// nothing. It waits at most two seconds for readers and writers to finish; if they don't, the
/// automatic checkpoints carry on as before.
pub async fn checkpoint(pool: &SqlitePool) {
    let job = crate::perf::Job::start("SQLite checkpoint", Duration::from_secs(5));
    let result: sqlx::Result<(i64, i64, i64)> = async {
        let mut conn = pool.acquire().await?;
        // Closed afterwards, not given back to the pool with the shorter wait.
        conn.close_on_drop();
        sqlx::query("PRAGMA busy_timeout = 2000").execute(&mut *conn).await?;
        sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)").fetch_one(&mut *conn).await
    }
    .await;
    match result {
        Ok((busy, frames, done)) => job.done(true, format!("{done} of {frames} pages copied{}", if busy != 0 { ", busy" } else { "" })),
        Err(e) => {
            tracing::warn!(error = %e, "write-ahead log checkpoint failed");
            job.done(false, "")
        }
    };
}

/// After a big import: checkpoint, then statistics.
pub async fn after_import(pool: &SqlitePool) {
    checkpoint(pool).await;
    optimize(pool).await;
}

#[cfg(test)]
pub async fn test_pool() -> SqlitePool {
    let opts = SqliteConnectOptions::from_str("sqlite::memory:").unwrap().foreign_keys(true);
    // One connection: each in-memory connection is its own database.
    let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    pool
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connections_are_tuned_and_optimize_writes_statistics() {
        let dir = tempfile::tempdir().unwrap();
        let pool = connect(&format!("sqlite://{}", dir.path().join("t.db").display()), Duration::from_millis(200)).await.unwrap();
        let cache: i64 = sqlx::query_scalar("PRAGMA cache_size").fetch_one(&pool).await.unwrap();
        assert_eq!(cache, -(CACHE_KIB as i64));
        let limit: i64 = sqlx::query_scalar("PRAGMA journal_size_limit").fetch_one(&pool).await.unwrap();
        assert_eq!(limit, WAL_LIMIT_BYTES as i64);
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('u', 'a@example.com', 'A', '2026-11-02')")
            .execute(&pool)
            .await
            .unwrap();
        after_import(&pool).await;
        let stats: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_stat1 WHERE tbl = 'users'").fetch_one(&pool).await.unwrap();
        assert!(stats > 0);
        // A second run finds nothing to do.
        let due: Vec<String> = sqlx::query_scalar("PRAGMA optimize=0x10003").fetch_all(&pool).await.unwrap();
        assert!(due.is_empty(), "{due:?}");
    }
}
