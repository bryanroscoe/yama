use crate::auth::GoogleKeys;
use crate::config::Config;
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use sqlx::SqlitePool;
use std::sync::Arc;
use axum::http::{header, HeaderValue, Method};
use tower::ServiceExt;
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

/// `/decks/lab/...` to `/lab/...` and `/decks/datasets/...` to `/lab/datasets/...`, query kept.
/// The target always starts with `/lab`, so it can't point off the site.
async fn old_lab(uri: axum::http::Uri) -> axum::response::Redirect {
    let path = match uri.path().strip_prefix("/decks") {
        Some(rest) if rest.starts_with("/datasets") => format!("/lab{rest}"),
        Some(rest) if rest.starts_with("/lab") => rest.to_string(),
        _ => "/lab".to_string(),
    };
    let to = match uri.query() {
        Some(q) => format!("{path}?{q}"),
        None => path,
    };
    axum::response::Redirect::permanent(&to)
}

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
        .merge(crate::sell::router())
        .merge(crate::decks::router())
        .merge(crate::analysis::history::router())
        .merge(crate::deck_scan::router())
        .merge(crate::deck_research::router())
        .merge(crate::datasets::router())
        .merge(crate::precon_evidence::router())
        .merge(crate::deck_import::router())
        .merge(crate::playgroups::router())
        .merge(crate::games::router())
        .merge(crate::game_export::router())
        .merge(crate::table_rooms::router())
        .merge(crate::play::router())
        .merge(crate::watch::router())
        .merge(crate::plan::router())
        .merge(crate::mpc::router())
        .merge(crate::lab::router())
        .merge(crate::public_precons::router())
        .merge(crate::public_commanders::router())
        .merge(crate::scan::router(&state.cfg.data_dir))
        .merge(crate::scan_samples::router())
        .merge(crate::sharing::router())
        .merge(crate::people::router())
        .merge(crate::advisor::router())
        .merge(crate::mcp::router())
        .merge(crate::mcp::changes::router())
        .merge(crate::oauth::router())
        // The Lab moved out of Decks to its own section (2026-10-28); old links keep working.
        .route("/decks/lab", get(old_lab))
        .route("/decks/lab/{*rest}", get(old_lab))
        // So did Datasets (2026-11-04), which are Lab evidence.
        .route("/decks/datasets", get(old_lab))
        .route("/decks/datasets/{*rest}", get(old_lab))
        // Unknown API paths are errors, not the web app.
        .route("/api/{*rest}", axum::routing::any(|| async { crate::error::AppError::NotFound("API route") }));

    // The Mythic Tools bridge, when it's switched on (YAMA_MYTHIC_BRIDGE=1).
    if state.cfg.mythic_bridge {
        router = router.merge(crate::bridges::mythic::router());
    }
    // phase's own board (play/board.rs), a separate app with its own client-side routes.
    if let Some(dist) = &state.cfg.board_dist {
        let index = dist.join("index.html");
        router = router.nest_service("/board", ServeDir::new(dist).fallback(ServeFile::new(index)));
    }
    // The phone apps call the API, and fetch the scanner's files, from their own origin with a
    // bearer token (no cookies). Only those: pages and the web app's files don't need CORS, and
    // its `Vary: Origin` kept the service worker's saved files from matching (web PR #110). The
    // validators go both ways, so the offline card list can be revalidated from a phone.
    if !state.cfg.cors_origins.is_empty() {
        let origins: Vec<HeaderValue> = state.cfg.cors_origins.iter().filter_map(|o| o.parse().ok()).collect();
        let cors = CorsLayer::new()
            .allow_origin(origins)
            .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE])
            .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::IF_NONE_MATCH, header::IF_MODIFIED_SINCE])
            .expose_headers([header::ETAG, header::LAST_MODIFIED]);
        router = router.layer(axum::middleware::from_fn_with_state(cors, api_cors));
    }
    // Admin "View as" stays read only: checked for every request, before routing (view_as.rs).
    router = router.layer(axum::middleware::from_fn_with_state(state.clone(), crate::view_as::guard));
    // Every request's time, by the route it matched (perf.rs; Admin, Server).
    router = router.layer(axum::middleware::from_fn(crate::perf::track));
    // A line per write request with the account that sent it, kept on the data volume (request_log.rs).
    router = router.layer(axum::middleware::from_fn(crate::request_log::log_writes));
    router = router.layer(CompressionLayer::new()).layer(TraceLayer::new_for_http());
    // The built web app, after the layers above: its files are precompressed and cached by
    // their own rules (web_files.rs), with no CORS. Still timed.
    if let Some(dist) = &state.cfg.web_dist {
        let files = crate::web_files::WebFiles::new(dist);
        let files = tower::service_fn(move |req: Request| files.clone().serve(req));
        router = router.fallback_service(tower::ServiceBuilder::new().layer(axum::middleware::from_fn(crate::perf::track)).service(files));
    }
    router.with_state(state)
}

/// The paths the phone apps fetch from another origin.
fn cross_origin(path: &str) -> bool {
    path.starts_with("/api/") || path.starts_with("/scan-bundle/")
}

/// CORS for [`cross_origin`] paths only.
async fn api_cors(State(cors): State<CorsLayer>, req: Request, next: Next) -> Response {
    if !cross_origin(req.uri().path()) {
        return next.run(req).await;
    }
    match tower::Layer::layer(&cors, next).oneshot(req).await {
        Ok(res) => res,
        Err(never) => match never {},
    }
}

/// The client for Yama's own outside requests. Nothing may hang: a connection gets 10 s and a
/// request two minutes, unless it sets its own (Ask Claude's answers, Forge games, the big
/// downloads, which also give up when a stream stalls: `util::next_chunk`).
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        // Scryfall asks every client to identify itself.
        .user_agent(concat!("Yama/", env!("CARGO_PKG_VERSION"), " (private Magic app)"))
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
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
    // The old daily table's newer days into the price history before anything reads the latest
    // prices (prices/backfill.rs; under a minute, the first start after migration 0060). A
    // failure stops the start.
    crate::prices::backfill::run_before_serving(&pool).await?;
    // The public rankings and the Lab's precon list, built before the server listens so no
    // request waits for one (derived.rs), then kept up to date.
    crate::derived::prewarm(&pool).await;
    crate::derived::spawn_prewarmer(pool.clone());
    // Table statistics for SQLite's planner now, then daily (db.rs).
    let stats = pool.clone();
    tokio::spawn(async move {
        loop {
            crate::db::optimize(&stats).await;
            tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
        }
    });
    if cfg.auto_import {
        crate::cards::import::spawn_scheduler(pool.clone(), cfg.data_dir.clone());
        crate::calendar::spawn_scheduler(pool.clone(), http_client());
        crate::deck_prices::spawn_scheduler(pool.clone(), http_client());
        // The scanner's recognition bundle, so the first scan doesn't wait on the download.
        let (dir, http) = (cfg.data_dir.clone(), http_client());
        tokio::spawn(async move { crate::scan::ensure(dir, http).await });
    }
    // Research answers are kept in the database (research_cache) so restarts reuse them; the deck
    // checks pace their Spellbook requests with it.
    let research = Arc::new(crate::mcp::research::client::Research::new(cfg.offline, pool.clone()));
    if cfg.deck_checks {
        crate::deck_checks::spawn_worker(pool.clone(), http_client(), crate::deck_checks::SPELLBOOK_ESTIMATE_URL.into(), research.clone());
    }
    let play = crate::play::PlayHub::start(cfg.engine_card_data.clone(), pool.clone());
    // Forge as a second Lab engine, when its worker container is set up (lab/forge.rs).
    let forge: Option<Arc<dyn crate::lab::forge::ForgeClient>> = match (cfg.forge.enabled(), &cfg.forge.url, &cfg.forge.secret) {
        (true, ..) if cfg.offline => None,
        (true, Some(url), Some(secret)) => {
            tracing::info!(url = %url, "Lab: Forge runs go to the Forge worker");
            Some(Arc::new(crate::lab::forge::HttpForge::new(http_client(), url.clone(), secret.clone())))
        }
        _ => None,
    };
    let lab = crate::lab::worker::LabWorker::start(pool.clone(), cfg.lab_threads, play.clone(), cfg.engine_card_data.clone(), forge);
    let bind = cfg.bind.clone();
    let offline = cfg.offline;
    if offline {
        tracing::warn!("YAMA_OFFLINE is on: no imports, deck checks, previews, store checks, Ask Claude, research, Google or Access sign-in, or Forge");
    }
    let cf_keys = match (&cfg.cf_access_team, &cfg.cf_access_aud) {
        // Access's signing keys come from Cloudflare.
        (Some(_), Some(_)) if cfg.offline => {
            tracing::warn!("YAMA_OFFLINE: Cloudflare Access sign-in is off");
            None
        }
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
        research,
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

    #[tokio::test]
    async fn offline_requests_say_so_instead_of_reaching_out() {
        let mut cfg = crate::testutil::config();
        cfg.offline = true;
        cfg.google_client_ids = vec!["client.apps.googleusercontent.com".into()];
        let st = crate::testutil::state_with(cfg, crate::db::test_pool().await).await;
        let pool = st.pool.clone();
        let app = crate::routes::app(st);
        let (id, token) = user(&pool, "bryan@example.com").await;
        sqlx::query("UPDATE users SET is_admin = 1 WHERE id = ?").bind(&id).execute(&pool).await.unwrap();
        // A precon list Yama has never downloaded.
        sqlx::query("INSERT INTO calendar_precons (file_name, set_code, name, first_seen_at) VALUES ('Test_TST', 'tst', 'Test', '2026-11-02')").execute(&pool).await.unwrap();
        for (method, path, body) in [
            (Method::GET, "/api/cards/preview?name=Sol%20Ring", None),
            (Method::GET, "/api/calendar/precons/Test_TST", None),
            (Method::POST, "/api/plan/stock/check", Some(json!({}))),
            (Method::POST, "/api/mpc/images", Some(json!({"cards": ["Sol Ring"]}))),
            (Method::POST, "/api/advisor/ask", Some(json!({"question": "Is Sol Ring good?"}))),
            (Method::POST, "/api/auth/google", Some(json!({"credential": "a.b.c"}))),
        ] {
            let (status, answer) = send(&app, method.clone(), path, Some(&token), body).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{method} {path}: {answer}");
            assert!(answer["error"].as_str().unwrap().starts_with("Unavailable offline"), "{method} {path}: {answer}");
        }
        let (status, bundle) = send(&app, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(bundle["error"].as_str().unwrap().starts_with("Unavailable offline"), "{bundle}");
    }

    #[tokio::test]
    async fn the_web_apps_files_have_their_own_caching_and_only_the_api_has_cors() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("index.html"), "<title>Yama</title>").unwrap();
        std::fs::write(dir.path().join("assets/app-1a2b.js"), "app").unwrap();
        let mut cfg = crate::testutil::config();
        cfg.web_dist = Some(dir.path().to_path_buf());
        cfg.cors_origins = vec!["https://localhost".into()];
        let app = crate::routes::app(crate::testutil::state_with(cfg, crate::db::test_pool().await).await);
        let get = |path: &str| {
            let req = Request::builder().uri(path).header(header::ORIGIN, "https://localhost").body(Body::empty()).unwrap();
            app.clone().oneshot(req)
        };
        let vary = |res: &axum::response::Response| res.headers().get_all(header::VARY).iter().map(|v| v.to_str().unwrap().to_lowercase()).collect::<Vec<_>>().join(",");
        let res = get("/assets/app-1a2b.js").await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CACHE_CONTROL], crate::web_files::IMMUTABLE);
        assert!(!vary(&res).contains("origin") && res.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
        let res = get("/assets/gone-0000.js").await.unwrap();
        assert_eq!((res.status(), res.headers()[header::CACHE_CONTROL].to_str().unwrap()), (StatusCode::NOT_FOUND, crate::web_files::NO_STORE));
        let res = get("/decks/123").await.unwrap();
        assert_eq!((res.status(), res.headers()[header::CACHE_CONTROL].to_str().unwrap()), (StatusCode::OK, crate::web_files::REVALIDATE));
        assert!(!vary(&res).contains("origin"));
        // The API still answers the phone apps' origin, and lets them read and send validators.
        let res = get("/api/health").await.unwrap();
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "https://localhost");
        assert!(vary(&res).contains("origin"));
        assert!(res.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS].to_str().unwrap().to_lowercase().contains("etag"));
        let preflight = Request::builder()
            .method(Method::OPTIONS)
            .uri("/api/cards/offline")
            .header(header::ORIGIN, "https://localhost")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
            .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "authorization,if-none-match")
            .body(Body::empty())
            .unwrap();
        let res = app.clone().oneshot(preflight).await.unwrap();
        assert!(res.status().is_success(), "{}", res.status());
        assert!(res.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS].to_str().unwrap().to_lowercase().contains("if-none-match"));
        // So does the scanner's files' folder, which the phone app's worker downloads from.
        let res = get(&format!("/scan-bundle/{}/detector.onnx", crate::scan::BUNDLE_VERSION)).await.unwrap();
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "https://localhost");
    }
}
