//! Pages built from the database and kept until their inputs change (2026-11-02): the public
//! precon and commander rankings and the Lab's precon list.
//!
//! Each kept value has a key: a cheap fingerprint of everything its build reads, plus the UTC day
//! for builds that read today's date. A request whose key no longer matches gets the kept value at
//! once while one rebuild runs in the background, so nobody waits for a rebuild (`/precons` took
//! 7 s on saget when its cache ran out). Only a build with nothing kept yet is waited for: the
//! server builds them all ([`prewarm`]) before it listens, then the prewarmer ([`spawn_prewarmer`])
//! looks every minute (which also catches imports and publications from the command line) and
//! right after an import here ([`nudge`]).
//!
//! Tests build every time: their in-memory databases share one name, so a key can't tell them apart.

use crate::error::AppResult;
use sqlx::SqlitePool;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

/// A rebuild slower than this is a warning (perf.rs).
const SLOW_BUILD: Duration = Duration::from_secs(2);
/// How often the prewarmer looks at every key.
const PREWARM_EVERY: Duration = Duration::from_secs(60);

pub struct Kept<T> {
    /// For the job line (`public precons rebuild`).
    name: &'static str,
    value: Mutex<Option<(String, Arc<T>)>>,
    /// One build at a time.
    building: tokio::sync::Mutex<()>,
}

impl<T: Send + Sync + 'static> Kept<T> {
    pub const fn new(name: &'static str) -> Self {
        Self { name, value: Mutex::new(None), building: tokio::sync::Mutex::const_new(()) }
    }

    fn kept(&self) -> Option<(String, Arc<T>)> {
        self.value.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The value for `key`: the kept one if its key matches; else the kept one while a rebuild runs
    /// in the background; else (nothing kept yet) a build the caller waits for.
    pub async fn get<F, Fut>(&'static self, pool: &SqlitePool, key: String, build: F) -> AppResult<Arc<T>>
    where
        F: FnOnce(SqlitePool) -> Fut + Send + 'static,
        Fut: Future<Output = AppResult<T>> + Send + 'static,
    {
        if cfg!(test) {
            return Ok(Arc::new(build(pool.clone()).await?));
        }
        self.serve(pool, key, build).await
    }

    async fn serve<F, Fut>(&'static self, pool: &SqlitePool, key: String, build: F) -> AppResult<Arc<T>>
    where
        F: FnOnce(SqlitePool) -> Fut + Send + 'static,
        Fut: Future<Output = AppResult<T>> + Send + 'static,
    {
        match self.kept() {
            Some((k, v)) if k == key => Ok(v),
            Some((_, v)) => {
                // The background rebuild holds the lock from here, so a burst of requests starts
                // one. A rebuild already running is followed by the next request if it was for
                // an older key.
                if let Ok(one) = self.building.try_lock() {
                    let pool = pool.clone();
                    tokio::spawn(async move {
                        if let Err(e) = self.build_locked(one, pool, key, build).await {
                            tracing::warn!(page = self.name, error = %e, "rebuilding a kept page failed; the old one is still served");
                        }
                    });
                }
                Ok(v)
            }
            None => self.rebuild(pool.clone(), key, build).await,
        }
    }

    /// Build now unless the kept value is already for `key` (the prewarmer).
    pub async fn refresh<F, Fut>(&'static self, pool: &SqlitePool, key: String, build: F) -> AppResult<()>
    where
        F: FnOnce(SqlitePool) -> Fut + Send + 'static,
        Fut: Future<Output = AppResult<T>> + Send + 'static,
    {
        if self.kept().is_some_and(|(k, _)| k == key) {
            return Ok(());
        }
        self.rebuild(pool.clone(), key, build).await.map(|_| ())
    }

    async fn rebuild<F, Fut>(&'static self, pool: SqlitePool, key: String, build: F) -> AppResult<Arc<T>>
    where
        F: FnOnce(SqlitePool) -> Fut,
        Fut: Future<Output = AppResult<T>>,
    {
        let one = self.building.lock().await;
        self.build_locked(one, pool, key, build).await
    }

    /// Build while holding the one-build lock (`_one`).
    async fn build_locked<F, Fut>(&'static self, _one: tokio::sync::MutexGuard<'static, ()>, pool: SqlitePool, key: String, build: F) -> AppResult<Arc<T>>
    where
        F: FnOnce(SqlitePool) -> Fut,
        Fut: Future<Output = AppResult<T>>,
    {
        if let Some((k, v)) = self.kept()
            && k == key
        {
            return Ok(v);
        }
        let job = crate::perf::Job::start(self.name, SLOW_BUILD);
        let built = build(pool).await;
        job.finish(&built, "");
        let v = Arc::new(built?);
        *self.value.lock().unwrap_or_else(|e| e.into_inner()) = Some((key, v.clone()));
        Ok(v)
    }
}

/// Today in UTC, for the keys of builds that read the date.
pub fn today() -> String {
    chrono::Utc::now().date_naive().to_string()
}

static NUDGE: Notify = Notify::const_new();

/// Something a kept page reads changed in this process (an import): look at every key now.
pub fn nudge() {
    NUDGE.notify_one();
}

/// Look at every kept page's key every minute and on [`nudge`], building those that changed. The
/// server awaits [`prewarm`] once before it listens, so no request after a start waits for a build.
pub fn spawn_prewarmer(pool: SqlitePool) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(PREWARM_EVERY) => {}
                _ = NUDGE.notified() => {}
            }
            prewarm(&pool).await;
        }
    });
}

/// Build every kept page whose key changed (all of them at startup).
pub async fn prewarm(pool: &SqlitePool) {
    let results = [
        ("public precons", crate::public_precons::prewarm(pool).await),
        ("public commanders", crate::public_commanders::prewarm(pool).await),
        ("Lab precon list", crate::lab::prewarm_precon_list(pool).await),
    ];
    for (page, result) in results {
        if let Err(e) = result {
            tracing::warn!(page, error = %e, "prewarming a kept page failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    static PAGE: Kept<String> = Kept::new("test page");

    async fn build(_: SqlitePool, label: &'static str, wait: Duration) -> AppResult<String> {
        tokio::time::sleep(wait).await;
        BUILDS.fetch_add(1, Ordering::SeqCst);
        Ok(label.to_string())
    }

    #[tokio::test]
    async fn a_changed_key_serves_the_kept_value_while_one_rebuild_runs() {
        let pool = crate::db::test_pool().await;
        // Nothing kept: the first request waits for the build.
        let v = PAGE.serve(&pool, "k1".into(), |p| build(p, "one", Duration::ZERO)).await.unwrap();
        assert_eq!(*v, "one");
        // Same key: kept, no build.
        PAGE.serve(&pool, "k1".into(), |p| build(p, "never", Duration::ZERO)).await.unwrap();
        assert_eq!(BUILDS.load(Ordering::SeqCst), 1);
        // A new key: the old value at once, while a slow rebuild runs; more requests meanwhile
        // don't start another.
        let v = PAGE.serve(&pool, "k2".into(), |p| build(p, "two", Duration::from_millis(200))).await.unwrap();
        assert_eq!(*v, "one");
        // A burst before the first rebuild has even started: still one rebuild.
        for _ in 0..5 {
            let v = PAGE.serve(&pool, "k2".into(), |p| build(p, "again", Duration::ZERO)).await.unwrap();
            assert_eq!(*v, "one");
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        let v = PAGE.serve(&pool, "k2".into(), |p| build(p, "never", Duration::ZERO)).await.unwrap();
        assert_eq!(*v, "two");
        assert_eq!(BUILDS.load(Ordering::SeqCst), 2);
        // The prewarmer builds only for a new key.
        PAGE.refresh(&pool, "k2".into(), |p| build(p, "never", Duration::ZERO)).await.unwrap();
        PAGE.refresh(&pool, "k3".into(), |p| build(p, "three", Duration::ZERO)).await.unwrap();
        assert_eq!(*PAGE.serve(&pool, "k3".into(), |p| build(p, "never", Duration::ZERO)).await.unwrap(), "three");
        assert_eq!(BUILDS.load(Ordering::SeqCst), 3);
    }
}
