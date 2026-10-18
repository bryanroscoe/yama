use crate::auth::GoogleKeys;
use crate::config::Config;
use axum::routing::get;
use axum::Router;
use sqlx::SqlitePool;
use std::sync::Arc;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub cfg: Arc<Config>,
    pub http: reqwest::Client,
    pub google_keys: Arc<GoogleKeys>,
    pub rooms: Arc<crate::table_rooms::Rooms>,
}

pub fn app(state: AppState) -> Router {
    let mut router = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .merge(crate::auth::router())
        .merge(crate::cards::router())
        .merge(crate::collection::router())
        .merge(crate::decks::router())
        .merge(crate::playgroups::router())
        .merge(crate::games::router())
        .merge(crate::table_rooms::router())
        // Unknown API paths are errors, not the web app.
        .route("/api/{*rest}", axum::routing::any(|| async { crate::error::AppError::NotFound("API route") }));

    // Serve the built web app, falling back to index.html for client-side routes.
    if let Some(dist) = &state.cfg.web_dist {
        let index = dist.join("index.html");
        router = router.fallback_service(ServeDir::new(dist).fallback(ServeFile::new(index)));
    }
    router.layer(TraceLayer::new_for_http()).with_state(state)
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        // Scryfall asks every client to identify itself.
        .user_agent(concat!("Yama/", env!("CARGO_PKG_VERSION"), " (private Magic app)"))
        .build()
        .expect("http client")
}

pub async fn serve(cfg: Config, pool: SqlitePool) -> anyhow::Result<()> {
    if cfg.dev_login {
        tracing::warn!("YAMA_DEV_LOGIN is on: anyone who can reach this server can sign in by email");
    }
    let bind = cfg.bind.clone();
    let state = AppState { pool, cfg: Arc::new(cfg), http: http_client(), google_keys: Arc::default(), rooms: Arc::default() };
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("listening on http://{bind}");
    axum::serve(listener, app(state)).await?;
    Ok(())
}
