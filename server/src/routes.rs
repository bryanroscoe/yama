use crate::auth::GoogleKeys;
use crate::config::Config;
use axum::routing::get;
use axum::Router;
use sqlx::SqlitePool;
use std::sync::Arc;
use axum::http::{header, HeaderValue, Method};
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub cfg: Arc<Config>,
    pub http: reqwest::Client,
    pub google_keys: Arc<GoogleKeys>,
    /// Cloudflare Access signing keys, when Access fronts this server.
    pub cf_keys: Option<Arc<crate::auth::JwkCache>>,
    pub rooms: Arc<crate::table_rooms::Rooms>,
    pub play: Arc<crate::play::PlayHub>,
    /// The simulation lab's experiment worker (shares the play hub's engine).
    pub lab: Arc<crate::lab::worker::LabWorker>,
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
        .merge(crate::play::router())
        .merge(crate::lab::router())
        // Unknown API paths are errors, not the web app.
        .route("/api/{*rest}", axum::routing::any(|| async { crate::error::AppError::NotFound("API route") }));

    // Serve the built web app, falling back to index.html for client-side routes.
    if let Some(dist) = &state.cfg.web_dist {
        let index = dist.join("index.html");
        router = router.fallback_service(ServeDir::new(dist).fallback(ServeFile::new(index)));
    }
    // The phone apps call the API from their own origin with a bearer token (no cookies).
    if !state.cfg.cors_origins.is_empty() {
        let origins: Vec<HeaderValue> = state.cfg.cors_origins.iter().filter_map(|o| o.parse().ok()).collect();
        router = router.layer(
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]),
        );
    }
    router.layer(CompressionLayer::new()).layer(TraceLayer::new_for_http()).with_state(state)
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
    if cfg.auto_import {
        crate::cards::import::spawn_scheduler(pool.clone(), cfg.data_dir.clone());
    }
    let play = crate::play::PlayHub::start(cfg.engine_card_data.clone(), pool.clone());
    let lab = crate::lab::worker::LabWorker::start(pool.clone(), cfg.lab_threads, play.clone(), cfg.engine_card_data.clone());
    let bind = cfg.bind.clone();
    let cf_keys = match (&cfg.cf_access_team, &cfg.cf_access_aud) {
        (Some(team), Some(_)) => {
            tracing::info!(team, "signing people in through Cloudflare Access");
            Some(Arc::new(crate::auth::JwkCache::new(&format!("https://{team}.cloudflareaccess.com/cdn-cgi/access/certs"))))
        }
        _ => None,
    };
    let state = AppState { pool, cfg: Arc::new(cfg), http: http_client(), google_keys: Arc::default(), cf_keys, rooms: Arc::default(), play, lab };
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("listening on http://{bind}");
    axum::serve(listener, app(state)).await?;
    Ok(())
}
