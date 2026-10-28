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
    /// Watched all-AI games, in memory (`watch.rs`).
    pub watch: Arc<crate::watch::WatchHub>,
    /// The simulation lab's experiment worker (shares the play hub's engine).
    pub lab: Arc<crate::lab::worker::LabWorker>,
    /// Rate limits (sign-in, searches, imports, joins...), in memory.
    pub limits: Arc<crate::limits::Limits>,
    /// Bounded public research cache and provider request pacing for MCP.
    pub research: Arc<crate::mcp::research::client::Research>,
}

pub fn app(state: AppState) -> Router {
    let mut router = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .merge(crate::auth::router())
        .merge(crate::admin::router())
        .merge(crate::view_as::router())
        .merge(crate::cards::router())
        .merge(crate::calendar::router())
        .merge(crate::collection::router())
        .merge(crate::decks::router())
        .merge(crate::deck_research::router())
        .merge(crate::deck_import::router())
        .merge(crate::playgroups::router())
        .merge(crate::games::router())
        .merge(crate::game_export::router())
        .merge(crate::table_rooms::router())
        .merge(crate::play::router())
        .merge(crate::watch::router())
        .merge(crate::plan::router())
        .merge(crate::lab::router())
        .merge(crate::public_precons::router())
        .merge(crate::scan::router(&state.cfg.data_dir))
        .merge(crate::advisor::router())
        .merge(crate::mcp::router())
        .merge(crate::mcp::changes::router())
        .merge(crate::oauth::router())
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
    // Admin "View as" stays read only: checked for every request, before routing (view_as.rs).
    router = router.layer(axum::middleware::from_fn_with_state(state.clone(), crate::view_as::guard));
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
    crate::admin::mark_started();
    if cfg.dev_login {
        tracing::warn!("YAMA_DEV_LOGIN is on: anyone who can reach this server can sign in by email");
    }
    if cfg.open_signup {
        if cfg.google_client_ids.is_empty() {
            tracing::warn!("YAMA_OPEN_SIGNUP is on but Google sign-in isn't set up (YAMA_GOOGLE_CLIENT_IDS), so nobody can sign up");
        } else {
            tracing::info!("open sign-up: anyone with a verified Google account can make an account");
        }
    }
    if cfg.auto_import {
        crate::cards::import::spawn_scheduler(pool.clone(), cfg.data_dir.clone());
        crate::calendar::spawn_scheduler(pool.clone(), http_client());
        crate::deck_prices::spawn_scheduler(pool.clone(), http_client());
        // The scanner's recognition bundle, so the first scan doesn't wait on the download.
        let (dir, http) = (cfg.data_dir.clone(), http_client());
        tokio::spawn(async move { crate::scan::ensure(dir, http).await });
    }
    if cfg.deck_checks {
        crate::deck_checks::spawn_worker(pool.clone(), http_client(), crate::deck_checks::SPELLBOOK_ESTIMATE_URL.into());
    }
    let play = crate::play::PlayHub::start(cfg.engine_card_data.clone(), pool.clone());
    // Forge as a second Lab engine, when its worker container is set up (lab/forge.rs).
    let forge: Option<Arc<dyn crate::lab::forge::ForgeClient>> = match (cfg.forge.enabled(), &cfg.forge.url, &cfg.forge.secret) {
        (true, Some(url), Some(secret)) => {
            tracing::info!(url = %url, "Lab: Forge runs go to the Forge worker");
            Some(Arc::new(crate::lab::forge::HttpForge::new(http_client(), url.clone(), secret.clone())))
        }
        _ => None,
    };
    let lab = crate::lab::worker::LabWorker::start(pool.clone(), cfg.lab_threads, play.clone(), cfg.engine_card_data.clone(), forge);
    let bind = cfg.bind.clone();
    let cf_keys = match (&cfg.cf_access_team, &cfg.cf_access_aud) {
        (Some(team), Some(_)) => {
            tracing::info!(team, "signing people in through Cloudflare Access");
            Some(Arc::new(crate::auth::JwkCache::new(&format!("https://{team}.cloudflareaccess.com/cdn-cgi/access/certs"))))
        }
        _ => None,
    };
    let state = AppState {
        pool,
        cfg: Arc::new(cfg),
        http: http_client(),
        google_keys: Arc::default(),
        cf_keys,
        rooms: Arc::default(),
        play,
        lab,
        watch: Arc::default(),
        limits: Arc::default(),
        research: Arc::default(),
    };
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("listening on http://{bind}");
    // The peer address feeds per-address limits (`limits::ClientAddress`).
    axum::serve(listener, app(state).into_make_service_with_connect_info::<std::net::SocketAddr>()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::testutil::{app, send, user};
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode, header};
    use serde_json::json;
    use tower::ServiceExt;

    #[tokio::test]
    async fn signed_out_requests_get_401() {
        let (app, pool) = app().await;
        let (status, _) = send(&app, Method::GET, "/api/health", None, None).await;
        assert_eq!(status, StatusCode::OK);

        let private = [
            (Method::GET, "/api/me"),
            (Method::GET, "/api/decks"),
            (Method::GET, "/api/collection"),
            (Method::GET, "/api/games"),
            (Method::GET, "/api/playgroups"),
            (Method::GET, "/api/cards/search?q=sol"),
            (Method::GET, "/api/printings/lookup?set=cmm&number=410"),
            (Method::GET, "/api/invites"),
            (Method::POST, "/api/games"),
            (Method::POST, "/api/collection/ops"),
            (Method::GET, "/api/advisor/status"),
            (Method::GET, "/api/advisor/conversations"),
            (Method::POST, "/api/advisor/ask"),
        ];
        for (method, path) in &private {
            let body = (*method == Method::POST).then(|| json!({}));
            let (status, body) = send(&app, method.clone(), path, None, body).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
            assert_eq!(body["error"], "not signed in", "{method} {path}");
        }

        // A made-up token and an expired session are signed out too.
        let (status, _) = send(&app, Method::GET, "/api/me", Some("not-a-real-token"), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (id, token) = user(&pool, "bryan@example.com").await;
        sqlx::query("UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z' WHERE user_id = ?").bind(&id).execute(&pool).await.unwrap();
        let (status, _) = send(&app, Method::GET, "/api/me", Some(&token), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn signed_in_requests_reach_the_routes() {
        let (app, pool) = app().await;
        let (_, token) = user(&pool, "bryan@example.com").await;

        // Bearer, as the phone apps send it.
        let (status, me) = send(&app, Method::GET, "/api/me", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(me["email"], "bryan@example.com");
        assert_eq!(me["is_admin"], false);

        // The session cookie, as the web app sends it.
        let req = Request::builder()
            .uri("/api/me")
            .header(header::COOKIE, format!("{}={token}", crate::auth::SESSION_COOKIE))
            .body(Body::empty())
            .unwrap();
        assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::OK);

        // Admin-only routes look like unknown routes to everyone else; unknown API paths are a JSON
        // 404, not the web app.
        let (status, body) = send(&app, Method::GET, "/api/invites", Some(&token), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "API route not found");
        let (status, body) = send(&app, Method::GET, "/api/no-such-route", Some(&token), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "API route not found");
    }
}
