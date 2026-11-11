//! OAuth for Yama's tools: the metadata, registration's redirect rules, the whole sign-in from
//! registration to a tool call, the refusals (verifier, redirect, expiry, replay), refresh rotation
//! and reuse, revoking, where the tokens work, View as, and the 401 challenge.

use super::{sweep_now, PREFIX_ACCESS, PREFIX_REFRESH};
use crate::testutil::{config, send, state_with, user};
use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tower::ServiceExt;

const BASE: &str = "https://yama.test";
const LOOPBACK: &str = "http://localhost:3118/callback";
const CLAUDE_AI: &str = "https://claude.ai/api/mcp/auth_callback";
const OPENAI_CALLBACK: &str = "https://chatgpt.com/connector_platform_oauth_redirect";
const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk0123456789";

fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

async fn oauth_app() -> (Router, SqlitePool) {
    let mut cfg = config();
    cfg.public_url = Some(BASE.into());
    let st = state_with(cfg, crate::db::test_pool().await).await;
    let pool = st.pool.clone();
    (crate::routes::app(st), pool)
}

/// One request with any headers; returns the status, headers and JSON body.
async fn request(app: &Router, method: Method, path: &str, headers: &[(&str, String)], body: Body) -> (StatusCode, HeaderMap, Value) {
    let mut req = Request::builder().method(method).uri(path);
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let res = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, headers, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// A form POST (token and revocation requests), optionally with HTTP Basic client credentials.
async fn form(app: &Router, path: &str, pairs: &[(&str, &str)], basic: Option<(&str, &str)>) -> (StatusCode, HeaderMap, Value) {
    let body: String = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs).finish();
    let mut headers = vec![("content-type", "application/x-www-form-urlencoded".to_string())];
    if let Some((id, secret)) = basic {
        headers.push(("authorization", format!("Basic {}", STANDARD.encode(format!("{id}:{secret}")))));
    }
    request(app, Method::POST, path, &headers, Body::from(body)).await
}

async fn register(app: &Router, body: Value) -> (StatusCode, Value) {
    let (status, _, json) = request(app, Method::POST, "/oauth/register", &[("content-type", "application/json".into())], Body::from(body.to_string())).await;
    (status, json)
}

/// A public client (as Claude registers) with one redirect URI; returns its id.
async fn public_client(app: &Router, redirect: &str) -> String {
    let (status, made) = register(app, json!({"client_name": "Claude Code (yama)", "redirect_uris": [redirect], "token_endpoint_auth_method": "none"})).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    made["client_id"].as_str().unwrap().to_string()
}

fn authorize_params(client: &str, redirect: &str, verifier: &str) -> Vec<(&'static str, String)> {
    vec![
        ("response_type", "code".into()),
        ("client_id", client.into()),
        ("redirect_uri", redirect.into()),
        ("code_challenge", challenge_for(verifier)),
        ("code_challenge_method", "S256".into()),
        ("scope", "mcp offline_access".into()),
        ("state", "st4te-123".into()),
        ("resource", format!("{BASE}/mcp")),
    ]
}

fn query(params: &[(&str, String)]) -> String {
    url::form_urlencoded::Serializer::new(String::new()).extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str()))).finish()
}

/// The consent page's check, as the signed-in `session`.
async fn check(app: &Router, session: &str, params: &[(&str, String)]) -> (StatusCode, Value) {
    send(app, Method::GET, &format!("/api/oauth/authorize?{}", query(params)), Some(session), None).await
}

/// Allow or Deny from the consent page, from our own origin.
async fn decide(app: &Router, session: &str, params: &[(&str, String)], approve: bool) -> (StatusCode, Value) {
    let mut body = serde_json::Map::new();
    for (k, v) in params {
        body.insert(k.to_string(), json!(v));
    }
    body.insert("approve".into(), json!(approve));
    let headers = [("authorization", format!("Bearer {session}")), ("origin", BASE.to_string()), ("content-type", "application/json".into())];
    let (status, _, json) = request(app, Method::POST, "/api/oauth/authorize", &headers, Body::from(Value::Object(body).to_string())).await;
    (status, json)
}

/// The query parameters of a redirect URL.
fn params_of(url: &str) -> std::collections::HashMap<String, String> {
    url::Url::parse(url).unwrap().query_pairs().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// Approve and return the code from the redirect.
async fn approve(app: &Router, session: &str, client: &str, redirect: &str, verifier: &str) -> String {
    let (status, r) = decide(app, session, &authorize_params(client, redirect, verifier), true).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    let to = r["redirect"].as_str().unwrap();
    assert!(to.starts_with(redirect), "{to}");
    let p = params_of(to);
    assert_eq!(p["state"], "st4te-123");
    assert_eq!(p["iss"], BASE);
    p["code"].clone()
}

async fn exchange(app: &Router, client: &str, code: &str, redirect: &str, verifier: &str) -> (StatusCode, HeaderMap, Value) {
    form(
        app,
        "/oauth/token",
        &[("grant_type", "authorization_code"), ("code", code), ("redirect_uri", redirect), ("code_verifier", verifier), ("client_id", client), ("resource", &format!("{BASE}/mcp"))],
        None,
    )
    .await
}

/// Register, approve and exchange: (client id, access token, refresh token).
async fn connect(app: &Router, session: &str) -> (String, String, String) {
    let client = public_client(app, LOOPBACK).await;
    let code = approve(app, session, &client, LOOPBACK, VERIFIER).await;
    let (status, _, t) = exchange(app, &client, &code, LOOPBACK, VERIFIER).await;
    assert_eq!(status, StatusCode::OK, "{t}");
    (client, t["access_token"].as_str().unwrap().into(), t["refresh_token"].as_str().unwrap().into())
}

async fn refresh(app: &Router, client: &str, token: &str) -> (StatusCode, Value) {
    let (status, _, t) = form(app, "/oauth/token", &[("grant_type", "refresh_token"), ("refresh_token", token), ("client_id", client)], None).await;
    (status, t)
}

fn rpc(method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
}

/// `tools/list` on `/mcp` with a bearer token: the status.
async fn tools_status(app: &Router, token: &str) -> StatusCode {
    send(app, Method::POST, "/mcp", Some(token), Some(rpc("tools/list", json!({})))).await.0
}

#[tokio::test]
async fn metadata_documents_describe_the_server_from_config() {
    let (app, _) = oauth_app().await;
    for path in ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"] {
        let (status, prm) = send(&app, Method::GET, path, None, None).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(prm["resource"], format!("{BASE}/mcp"));
        assert_eq!(prm["authorization_servers"], json!([BASE]));
        assert_eq!(prm["scopes_supported"], json!(["mcp"]));
        assert_eq!(prm["bearer_methods_supported"], json!(["header"]));
    }
    // The Host header is never used for the addresses.
    let (_, _, prm) = request(&app, Method::GET, "/.well-known/oauth-protected-resource/mcp", &[("host", "evil.example".into())], Body::empty()).await;
    assert_eq!(prm["resource"], format!("{BASE}/mcp"));

    let (status, asm) = send(&app, Method::GET, "/.well-known/oauth-authorization-server", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(asm["issuer"], BASE);
    assert_eq!(asm["authorization_endpoint"], format!("{BASE}/oauth/authorize"));
    assert_eq!(asm["token_endpoint"], format!("{BASE}/oauth/token"));
    assert_eq!(asm["registration_endpoint"], format!("{BASE}/oauth/register"));
    assert_eq!(asm["revocation_endpoint"], format!("{BASE}/oauth/revoke"));
    assert_eq!(asm["response_types_supported"], json!(["code"]));
    assert_eq!(asm["grant_types_supported"], json!(["authorization_code", "refresh_token"]));
    assert_eq!(asm["code_challenge_methods_supported"], json!(["S256"]));
    assert_eq!(asm["scopes_supported"], json!(["mcp", "offline_access"]));
    assert!(asm["token_endpoint_auth_methods_supported"].as_array().unwrap().contains(&json!("none")));
    assert_eq!(asm["authorization_response_iss_parameter_supported"], true);
    // No Client ID Metadata Documents: Claude then registers through DCR.
    assert!(asm.get("client_id_metadata_document_supported").is_none());

    // Without YAMA_PUBLIC_URL there is no OAuth at all.
    let (plain, _) = crate::testutil::app().await;
    for path in ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"] {
        assert_eq!(send(&plain, Method::GET, path, None, None).await.0, StatusCode::NOT_FOUND, "{path}");
    }
    let (status, _) = register(&plain, json!({"redirect_uris": [LOOPBACK], "token_endpoint_auth_method": "none"})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn openai_plugin_callback_supports_sign_in_refresh_and_revocation() {
    let (app, pool) = oauth_app().await;
    let (_, session) = user(&pool, "plugin@example.com").await;
    let (status, made) = register(&app, json!({
        "client_name": "Yama for ChatGPT and Codex",
        "redirect_uris": [OPENAI_CALLBACK],
        "token_endpoint_auth_method": "none"
    })).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    let client = made["client_id"].as_str().unwrap();
    // Allowlisting a host does not permit an unregistered path for this client.
    let (status, _) = check(&app, &session, &authorize_params(client, "https://chatgpt.com/other", VERIFIER)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let code = approve(&app, &session, client, OPENAI_CALLBACK, VERIFIER).await;
    let (status, _, token) = exchange(&app, client, &code, OPENAI_CALLBACK, VERIFIER).await;
    assert_eq!(status, StatusCode::OK, "{token}");
    let access = token["access_token"].as_str().unwrap();
    let (status, result) = send(&app, Method::POST, "/mcp", Some(access), Some(rpc("tools/call", json!({"name": "overview", "arguments": {}})))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["result"]["isError"], false, "{result}");
    let (status, _, refreshed) = form(&app, "/oauth/token", &[
        ("grant_type", "refresh_token"),
        ("refresh_token", token["refresh_token"].as_str().unwrap()),
        ("client_id", client),
        ("resource", &format!("{BASE}/mcp")),
    ], None).await;
    assert_eq!(status, StatusCode::OK, "{refreshed}");
    let new_access = refreshed["access_token"].as_str().unwrap();
    assert_eq!(tools_status(&app, new_access).await, StatusCode::OK);
    let (status, _, _) = form(&app, "/oauth/revoke", &[("token", new_access), ("client_id", client)], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tools_status(&app, access).await, StatusCode::UNAUTHORIZED);
    assert_eq!(tools_status(&app, new_access).await, StatusCode::UNAUTHORIZED);

    let mut cfg = config();
    cfg.public_url = Some(BASE.into());
    cfg.oauth_redirect_hosts.clear();
    let restricted = crate::routes::app(state_with(cfg, crate::db::test_pool().await).await);
    let (status, error) = register(&restricted, json!({"redirect_uris": [OPENAI_CALLBACK]})).await;
    assert_eq!((status, error["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_redirect_uri")));
}

#[tokio::test]
async fn the_401_says_where_to_sign_in() {
    let (app, _) = oauth_app().await;
    let ping = rpc("ping", json!({}));
    let (status, headers, _) =
        request(&app, Method::POST, "/mcp", &[("content-type", "application/json".into())], Body::from(ping.to_string())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        headers[header::WWW_AUTHENTICATE],
        format!(r#"Bearer resource_metadata="{BASE}/.well-known/oauth-protected-resource/mcp", scope="mcp""#)
    );
    // A token that doesn't work also says so (and Claude refreshes on it).
    let (status, headers, _) = request(
        &app,
        Method::POST,
        "/mcp",
        &[("content-type", "application/json".into()), ("authorization", format!("Bearer {PREFIX_ACCESS}nope"))],
        Body::from(ping.to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let www = headers[header::WWW_AUTHENTICATE].to_str().unwrap();
    assert!(www.starts_with(r#"Bearer error="invalid_token", resource_metadata="https://yama.test/.well-known/oauth-protected-resource/mcp""#), "{www}");
    assert!(www.ends_with(r#"scope="mcp""#), "{www}");

    // Without OAuth set up, the challenge stays bare.
    let (plain, _) = crate::testutil::app().await;
    let (_, headers, _) = request(&plain, Method::POST, "/mcp", &[("content-type", "application/json".into())], Body::from(ping.to_string())).await;
    assert_eq!(headers[header::WWW_AUTHENTICATE], "Bearer");
}

#[tokio::test]
async fn registration_accepts_only_loopback_and_allowlisted_https() {
    let (app, pool) = oauth_app().await;
    for ok in ["http://localhost:3118/callback", "http://localhost:59999/callback", "http://127.0.0.1:40123/callback", "http://[::1]:5000/cb", CLAUDE_AI, "https://claude.com/api/mcp/auth_callback", OPENAI_CALLBACK, "https://chatgpt.com/connector/oauth/test-callback"] {
        let (status, made) = register(&app, json!({"redirect_uris": [ok], "token_endpoint_auth_method": "none"})).await;
        assert_eq!(status, StatusCode::CREATED, "{ok}: {made}");
        assert_eq!(made["redirect_uris"], json!([ok]));
        assert_eq!(made["token_endpoint_auth_method"], "none");
        assert!(made.get("client_secret").is_none(), "a public client gets no secret");
    }
    for bad in ["https://evil.com/callback", "http://evil.com/callback", "http://192.0.2.10:8080/callback", "https://claude.ai.evil.com/cb", "https://chatgpt.com.evil.com/cb", "https://evilchatgpt.com/cb", "http://chatgpt.com/cb", "myapp://callback"] {
        let (status, err) = register(&app, json!({"redirect_uris": [bad], "token_endpoint_auth_method": "none"})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        assert_eq!(err["error"], "invalid_redirect_uri", "{bad}");
    }
    // One bad URI spoils the lot.
    let (status, _) = register(&app, json!({"redirect_uris": [LOOPBACK, "https://evil.com/cb"], "token_endpoint_auth_method": "none"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, err) = register(&app, json!({"client_name": "x"})).await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_redirect_uri")));
    let (status, err) = register(&app, json!({"redirect_uris": [LOOPBACK], "token_endpoint_auth_method": "private_key_jwt"})).await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_client_metadata")));
    let (status, err) = register(&app, json!({"redirect_uris": [LOOPBACK], "grant_types": ["client_credentials"]})).await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_client_metadata")));
    let (status, _, _) = request(&app, Method::POST, "/oauth/register", &[("content-type", "application/json".into())], Body::from("not json")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // The name is the app's claim: hidden characters go, and it's capped.
    let long = format!("Claude\u{202E}\u{0007} Code {}", "x".repeat(200));
    let (status, made) = register(&app, json!({"client_name": long, "redirect_uris": [LOOPBACK]})).await;
    assert_eq!(status, StatusCode::CREATED);
    let name = made["client_name"].as_str().unwrap();
    assert!(name.starts_with("Claude Code xxx"), "{name}");
    assert_eq!(name.chars().count(), 80);
    // RFC 7591's default method is client_secret_basic, which comes with a secret.
    assert_eq!(made["token_endpoint_auth_method"], "client_secret_basic");
    let secret = made["client_secret"].as_str().unwrap();
    assert!(secret.starts_with("yama_ocs_"));
    let stored: Option<String> = sqlx::query_scalar("SELECT secret_hash FROM oauth_clients WHERE id = ?").bind(made["client_id"].as_str().unwrap()).fetch_one(&pool).await.unwrap();
    assert_eq!(stored.as_deref(), Some(crate::util::sha256_hex(secret).as_str()), "only the hash is kept");
}

#[tokio::test]
async fn the_whole_sign_in_ends_in_a_tool_call() {
    let (app, pool) = oauth_app().await;
    let (_, session) = user(&pool, "bryan@example.com").await;
    let client = public_client(&app, LOOPBACK).await;

    // The consent page's check: who is asking, where it goes back to, which account.
    let params = authorize_params(&client, LOOPBACK, VERIFIER);
    let (status, c) = check(&app, &session, &params).await;
    assert_eq!(status, StatusCode::OK, "{c}");
    assert_eq!(c["ok"], true);
    assert_eq!(c["client_name"], "Claude Code (yama)");
    assert_eq!(c["redirect_host"], "localhost");
    assert_eq!(c["loopback"], true);
    assert_eq!(c["account"]["email"], "bryan@example.com");
    assert_eq!(c["scopes"], json!(["mcp", "offline_access"]));
    // Claude Code's random port differs between registration and sign-in at times: still fine.
    let moved = authorize_params(&client, "http://127.0.0.1:50505/callback", VERIFIER);
    assert_eq!(check(&app, &session, &moved).await.1["ok"], true);
    // Signed out, the page asks for the usual sign-in first.
    assert_eq!(send(&app, Method::GET, &format!("/api/oauth/authorize?{}", query(&params)), None, None).await.0, StatusCode::UNAUTHORIZED);

    let code = approve(&app, &session, &client, LOOPBACK, VERIFIER).await;
    let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oauth_codes WHERE code_hash = ?").bind(crate::util::sha256_hex(&code)).fetch_one(&pool).await.unwrap();
    assert_eq!(stored, 1, "the code is stored hashed");

    let (status, headers, t) = exchange(&app, &client, &code, LOOPBACK, VERIFIER).await;
    assert_eq!(status, StatusCode::OK, "{t}");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(t["token_type"], "Bearer");
    assert_eq!(t["expires_in"], 3600);
    assert_eq!(t["scope"], "mcp offline_access");
    let access = t["access_token"].as_str().unwrap();
    assert!(access.starts_with(PREFIX_ACCESS));
    assert!(t["refresh_token"].as_str().unwrap().starts_with(PREFIX_REFRESH));

    let init = rpc("initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}));
    let (status, r) = send(&app, Method::POST, "/mcp", Some(access), Some(init)).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    let (status, r) = send(&app, Method::POST, "/mcp", Some(access), Some(rpc("tools/list", json!({})))).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    assert!(r["result"]["tools"].as_array().unwrap().iter().any(|t| t["name"] == "get_overview"));
    let (status, r) = send(&app, Method::POST, "/mcp", Some(access), Some(rpc("tools/call", json!({"name": "overview", "arguments": {}})))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(r["result"]["isError"], false, "{r}");

    // It shows under Connected apps, with its last use.
    let (status, apps) = send(&app, Method::GET, "/api/me/connected-apps", Some(&session), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(apps["enabled"], true);
    assert_eq!(apps["mcp_url"], format!("{BASE}/mcp"));
    let list = apps["apps"].as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["name"], "Claude Code (yama)");
    assert_eq!(list[0]["redirect_host"], "localhost");
    assert!(list[0]["last_used_at"].is_string());

    // The confidential flavour works too: HTTP Basic with the secret, and a wrong secret is refused.
    let (_, made) = register(&app, json!({"client_name": "Desk app", "redirect_uris": [CLAUDE_AI]})).await;
    let (id, secret) = (made["client_id"].as_str().unwrap().to_string(), made["client_secret"].as_str().unwrap().to_string());
    let code = approve(&app, &session, &id, CLAUDE_AI, VERIFIER).await;
    let pairs = [("grant_type", "authorization_code"), ("code", code.as_str()), ("redirect_uri", CLAUDE_AI), ("code_verifier", VERIFIER)];
    let (status, headers, err) = form(&app, "/oauth/token", &pairs, Some((&id, "wrong"))).await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::UNAUTHORIZED, Some("invalid_client")));
    assert_eq!(headers[header::WWW_AUTHENTICATE], r#"Basic realm="yama""#);
    let (status, _, t) = form(&app, "/oauth/token", &pairs, Some((&id, &secret))).await;
    assert_eq!(status, StatusCode::OK, "{t}");
    // An unknown client hears invalid_client, which tells Claude to register again.
    let (status, _, err) = form(&app, "/oauth/token", &[("grant_type", "refresh_token"), ("refresh_token", "x"), ("client_id", "gone")], None).await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::UNAUTHORIZED, Some("invalid_client")));
}

#[tokio::test]
async fn bad_codes_are_refused_and_a_replay_cuts_the_connection() {
    let (app, pool) = oauth_app().await;
    let (_, session) = user(&pool, "bryan@example.com").await;
    let client = public_client(&app, LOOPBACK).await;
    let code = approve(&app, &session, &client, LOOPBACK, VERIFIER).await;

    let wrong_verifier = "x".repeat(50);
    let (status, _, err) = exchange(&app, &client, &code, LOOPBACK, &wrong_verifier).await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_grant")));
    let (status, _, err) = exchange(&app, &client, &code, "http://localhost:9999/callback", VERIFIER).await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_grant")), "redirect_uri must be exactly the one used");
    let other = public_client(&app, LOOPBACK).await;
    let (status, _, err) = exchange(&app, &other, &code, LOOPBACK, VERIFIER).await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_grant")), "another app can't use it");
    let (status, _, err) = form(
        &app,
        "/oauth/token",
        &[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", LOOPBACK), ("code_verifier", VERIFIER), ("client_id", &client), ("resource", "https://evil.example/mcp")],
        None,
    )
    .await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_target")));

    // Those failures didn't use the code up; the right request works once.
    let (status, _, t) = exchange(&app, &client, &code, LOOPBACK, VERIFIER).await;
    assert_eq!(status, StatusCode::OK, "{t}");
    let access = t["access_token"].as_str().unwrap();
    let refresh_token = t["refresh_token"].as_str().unwrap();
    assert_eq!(tools_status(&app, access).await, StatusCode::OK);

    // A second use is a replay: refused, and the connection the code made is revoked.
    let (status, _, err) = exchange(&app, &client, &code, LOOPBACK, VERIFIER).await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_grant")));
    assert_eq!(tools_status(&app, access).await, StatusCode::UNAUTHORIZED);
    assert_eq!(refresh(&app, &client, refresh_token).await.1["error"], "invalid_grant");
    let reason: String = sqlx::query_scalar("SELECT revoke_reason FROM oauth_grants").fetch_one(&pool).await.unwrap();
    assert_eq!(reason, "code replayed");

    // An expired code.
    let code = approve(&app, &session, &client, LOOPBACK, VERIFIER).await;
    sqlx::query("UPDATE oauth_codes SET expires_at = '2000-01-01T00:00:00Z' WHERE code_hash = ?").bind(crate::util::sha256_hex(&code)).execute(&pool).await.unwrap();
    let (status, _, err) = exchange(&app, &client, &code, LOOPBACK, VERIFIER).await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_grant")));
    // A made-up code.
    let (status, _, err) = exchange(&app, &client, "not-a-code", LOOPBACK, VERIFIER).await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_grant")));
    // Missing pieces and unknown grants.
    let (status, _, err) = form(&app, "/oauth/token", &[("grant_type", "authorization_code"), ("client_id", &client)], None).await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_request")));
    let (status, _, err) = form(&app, "/oauth/token", &[("grant_type", "client_credentials"), ("client_id", &client)], None).await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::BAD_REQUEST, Some("unsupported_grant_type")));
}

#[tokio::test]
async fn bad_authorization_requests_never_redirect_to_an_unknown_place() {
    let (app, pool) = oauth_app().await;
    let (_, session) = user(&pool, "bryan@example.com").await;
    let client = public_client(&app, LOOPBACK).await;
    let good = authorize_params(&client, LOOPBACK, VERIFIER);
    let with = |key: &str, value: Option<&str>| -> Vec<(&'static str, String)> {
        let mut p: Vec<(&'static str, String)> = good.iter().filter(|(k, _)| *k != key).cloned().collect();
        if let Some(v) = value {
            let k: &'static str = good.iter().find(|(k, _)| *k == key).unwrap().0;
            p.push((k, v.to_string()));
        }
        p
    };

    // No trustworthy redirect: an error on Yama's page, never a redirect.
    for (params, why) in [
        (with("client_id", Some("not-registered")), "unknown client"),
        (with("client_id", None), "no client"),
        (with("redirect_uri", Some("https://evil.com/callback")), "unregistered redirect"),
        (with("redirect_uri", Some("http://localhost:3118/other")), "another path"),
        (with("redirect_uri", None), "no redirect"),
    ] {
        let (status, r) = check(&app, &session, &params).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{why}: {r}");
        assert!(r.get("redirect").is_none(), "{why}");
        let (status, r) = decide(&app, &session, &params, true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{why}: {r}");
        assert!(r.get("redirect").is_none(), "{why}");
    }

    // The app's own mistakes go back to the app, with state and iss.
    for (params, error) in [
        (with("code_challenge", None), "invalid_request"),
        (with("code_challenge_method", Some("plain")), "invalid_request"),
        (with("code_challenge_method", None), "invalid_request"),
        (with("response_type", Some("token")), "unsupported_response_type"),
        (with("scope", Some("mcp admin")), "invalid_scope"),
        (with("resource", Some("https://other.example/mcp")), "invalid_target"),
    ] {
        let (status, r) = check(&app, &session, &params).await;
        assert_eq!(status, StatusCode::OK, "{error}: {r}");
        assert_eq!(r["ok"], false);
        let p = params_of(r["redirect"].as_str().unwrap());
        assert_eq!(p["error"], error);
        assert_eq!(p["state"], "st4te-123");
        assert_eq!(p["iss"], BASE);
        // Approving doesn't make a code for a bad request.
        let (_, r) = decide(&app, &session, &params, true).await;
        assert!(!params_of(r["redirect"].as_str().unwrap()).contains_key("code"), "{error}");
    }
    let codes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oauth_codes").fetch_one(&pool).await.unwrap();
    assert_eq!(codes, 0);

    // Deny goes back with access_denied.
    let (status, r) = decide(&app, &session, &good, false).await;
    assert_eq!(status, StatusCode::OK);
    let p = params_of(r["redirect"].as_str().unwrap());
    assert_eq!((p["error"].as_str(), p["state"].as_str()), ("access_denied", "st4te-123"));
    assert!(!p.contains_key("code"));

    // Only Yama's own page may answer: no Origin, or another site's, is refused.
    let body = json!({"approve": true, "client_id": client, "redirect_uri": LOOPBACK, "response_type": "code", "code_challenge": challenge_for(VERIFIER), "code_challenge_method": "S256"});
    for origin in [None, Some("https://evil.example"), Some("https://yama.test.evil.example")] {
        let mut headers = vec![("authorization", format!("Bearer {session}")), ("content-type", "application/json".to_string())];
        if let Some(o) = origin {
            headers.push(("origin", o.to_string()));
        }
        let (status, _, _) = request(&app, Method::POST, "/api/oauth/authorize", &headers, Body::from(body.to_string())).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{origin:?}");
    }
    let codes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oauth_codes").fetch_one(&pool).await.unwrap();
    assert_eq!(codes, 0);
}

#[tokio::test]
async fn refresh_tokens_rotate_and_a_reused_one_revokes_the_grant() {
    let (app, pool) = oauth_app().await;
    let (_, session) = user(&pool, "bryan@example.com").await;
    let (client, access1, refresh1) = connect(&app, &session).await;

    let (status, t) = refresh(&app, &client, &refresh1).await;
    assert_eq!(status, StatusCode::OK, "{t}");
    let (access2, refresh2) = (t["access_token"].as_str().unwrap().to_string(), t["refresh_token"].as_str().unwrap().to_string());
    assert_ne!(refresh1, refresh2);
    assert_eq!(tools_status(&app, &access2).await, StatusCode::OK);
    // Asking for more than was granted on refresh is refused.
    let (status, _, err) = form(&app, "/oauth/token", &[("grant_type", "refresh_token"), ("refresh_token", &refresh2), ("client_id", &client), ("scope", "mcp admin")], None).await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_scope")));
    // Another app can't use it.
    let other = public_client(&app, LOOPBACK).await;
    assert_eq!(refresh(&app, &other, &refresh2).await.1["error"], "invalid_grant");

    // Two refreshes racing: the old token still works for a few seconds after its first use.
    let (status, t) = refresh(&app, &client, &refresh1).await;
    assert_eq!(status, StatusCode::OK, "within the grace period: {t}");

    // After that, using it again is a reuse: the whole grant goes, new tokens included.
    sqlx::query("UPDATE oauth_tokens SET used_at = '2000-01-01T00:00:00Z' WHERE token_hash = ?").bind(crate::util::sha256_hex(&refresh1)).execute(&pool).await.unwrap();
    let (status, err) = refresh(&app, &client, &refresh1).await;
    assert_eq!((status, err["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_grant")));
    for token in [&access1, &access2] {
        assert_eq!(tools_status(&app, token).await, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(refresh(&app, &client, &refresh2).await.1["error"], "invalid_grant");
    let reason: String = sqlx::query_scalar("SELECT revoke_reason FROM oauth_grants").fetch_one(&pool).await.unwrap();
    assert_eq!(reason, "refresh token reused");
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oauth_tokens").fetch_one(&pool).await.unwrap();
    assert_eq!(left, 0);

    // An expired refresh token.
    let (client, _, refresh3) = connect(&app, &session).await;
    sqlx::query("UPDATE oauth_tokens SET expires_at = '2000-01-01T00:00:00Z' WHERE token_hash = ?").bind(crate::util::sha256_hex(&refresh3)).execute(&pool).await.unwrap();
    assert_eq!(refresh(&app, &client, &refresh3).await.1["error"], "invalid_grant");
}

#[tokio::test]
async fn disconnecting_or_revoking_ends_the_connection() {
    let (app, pool) = oauth_app().await;
    let (_, session) = user(&pool, "bryan@example.com").await;
    let (_, other_session) = user(&pool, "someone@example.com").await;

    // Disconnect in Settings.
    let (client, access, refresh_token) = connect(&app, &session).await;
    let (_, apps) = send(&app, Method::GET, "/api/me/connected-apps", Some(&session), None).await;
    let id = apps["apps"][0]["id"].as_str().unwrap().to_string();
    // Someone else can't see or end it.
    let (_, theirs) = send(&app, Method::GET, "/api/me/connected-apps", Some(&other_session), None).await;
    assert_eq!(theirs["apps"], json!([]));
    let (status, _) = send(&app, Method::DELETE, &format!("/api/me/connected-apps/{id}"), Some(&other_session), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(tools_status(&app, &access).await, StatusCode::OK);
    let (status, _) = send(&app, Method::DELETE, &format!("/api/me/connected-apps/{id}"), Some(&session), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(tools_status(&app, &access).await, StatusCode::UNAUTHORIZED);
    assert_eq!(refresh(&app, &client, &refresh_token).await.1["error"], "invalid_grant");
    let (_, apps) = send(&app, Method::GET, "/api/me/connected-apps", Some(&session), None).await;
    assert_eq!(apps["apps"], json!([]));

    // The app's own revocation (RFC 7009): another app's request does nothing; its own ends it.
    let (client, access, _) = connect(&app, &session).await;
    let stranger = public_client(&app, LOOPBACK).await;
    let (status, _, _) = form(&app, "/oauth/revoke", &[("token", &access), ("client_id", &stranger)], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tools_status(&app, &access).await, StatusCode::OK);
    let (status, headers, _) = form(&app, "/oauth/revoke", &[("token", &access), ("client_id", &client)], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(tools_status(&app, &access).await, StatusCode::UNAUTHORIZED);
    // An unknown token is fine (RFC 7009 2.2).
    let (status, _, _) = form(&app, "/oauth/revoke", &[("token", "nothing"), ("client_id", &client)], None).await;
    assert_eq!(status, StatusCode::OK);

    // A disabled account's tokens stop working.
    let (client, access, refresh_token) = connect(&app, &session).await;
    sqlx::query("UPDATE users SET disabled_at = '2026-01-01T00:00:00Z' WHERE email = 'bryan@example.com'").execute(&pool).await.unwrap();
    assert_eq!(tools_status(&app, &access).await, StatusCode::UNAUTHORIZED);
    assert_eq!(refresh(&app, &client, &refresh_token).await.1["error"], "invalid_grant");
}

#[tokio::test]
async fn oauth_tokens_work_only_on_mcp() {
    let (app, pool) = oauth_app().await;
    let (_, session) = user(&pool, "bryan@example.com").await;
    let (_, access, refresh_token) = connect(&app, &session).await;
    assert_eq!(tools_status(&app, &access).await, StatusCode::OK);
    for (method, path) in [
        (Method::GET, "/api/me"),
        (Method::GET, "/api/decks"),
        (Method::GET, "/api/collection"),
        (Method::GET, "/api/plan/head"),
        (Method::GET, "/api/me/tokens"),
        (Method::GET, "/api/me/connected-apps"),
        (Method::GET, &format!("/api/oauth/authorize?client_id=x") as &str),
    ] {
        for token in [&access, &refresh_token] {
            let (status, _) = send(&app, method.clone(), path, Some(token), None).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
        }
    }
    // Not even with the session cookie beside it: an OAuth bearer never falls back.
    let (status, _, _) = request(
        &app,
        Method::GET,
        "/api/me",
        &[("authorization", format!("Bearer {access}")), ("cookie", format!("{}={session}", crate::auth::SESSION_COOKIE))],
        Body::empty(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // A refresh token isn't an access token.
    assert_eq!(tools_status(&app, &refresh_token).await, StatusCode::UNAUTHORIZED);
    // An access token can't approve another app or make keys.
    let (status, _) = decide(&app, &access, &authorize_params("x", LOOPBACK, VERIFIER), true).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = send(&app, Method::POST, "/api/me/tokens", Some(&access), Some(json!({"name": "x", "scope": "mcp"}))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn no_connection_is_made_while_an_admin_views_as_someone() {
    let (app, pool) = oauth_app().await;
    let (admin_id, admin) = user(&pool, "admin@example.com").await;
    sqlx::query("UPDATE users SET is_admin = 1 WHERE id = ?").bind(&admin_id).execute(&pool).await.unwrap();
    let (pat_id, _) = user(&pool, "pat@example.com").await;
    let (status, _, headers) = {
        let (s, h, b) = request(&app, Method::POST, &format!("/api/admin/users/{pat_id}/view"), &[("authorization", format!("Bearer {admin}"))], Body::empty()).await;
        (s, b, h)
    };
    assert_eq!(status, StatusCode::OK);
    let view = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|v| v.split(';').next()?.strip_prefix("yama_view=").map(str::to_string))
        .unwrap();
    let client = public_client(&app, LOOPBACK).await;
    let params = authorize_params(&client, LOOPBACK, VERIFIER);
    let viewing = [("authorization", format!("Bearer {admin}")), ("cookie", format!("yama_view={view}")), ("origin", BASE.to_string()), ("content-type", "application/json".into())];

    // The check refuses, so the page never offers Allow.
    let (status, _, r) = request(&app, Method::GET, &format!("/api/oauth/authorize?{}", query(&params)), &viewing, Body::empty()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{r}");
    assert!(r["error"].as_str().unwrap().contains("viewing"), "{r}");
    // And approving is refused.
    let mut body = serde_json::Map::new();
    for (k, v) in &params {
        body.insert(k.to_string(), json!(v));
    }
    body.insert("approve".into(), json!(true));
    let (status, _, r) = request(&app, Method::POST, "/api/oauth/authorize", &viewing, Body::from(Value::Object(body).to_string())).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{r}");
    let codes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oauth_codes").fetch_one(&pool).await.unwrap();
    assert_eq!(codes, 0);
    // Their connected apps stay private too.
    let (status, _, _) = request(&app, Method::GET, "/api/me/connected-apps", &viewing, Body::empty()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // An account shut out by closed sign-up can't connect: a Google account without an invite.
    let (limited, limited_session) = user(&pool, "joined@example.com").await;
    sqlx::query("UPDATE users SET google_sub = 'g-1' WHERE id = ?").bind(&limited).execute(&pool).await.unwrap();
    let (status, _) = check(&app, &limited_session, &params).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "its session doesn't work at all while open sign-up is off");
}

#[tokio::test]
async fn unused_clients_and_dead_tokens_are_swept() {
    let (app, pool) = oauth_app().await;
    let (_, session) = user(&pool, "bryan@example.com").await;
    let (used, _, _) = connect(&app, &session).await;
    let unused = public_client(&app, LOOPBACK).await;
    // Two days on, the client nobody signed in with goes; the connected one stays with its grant.
    let later = chrono::Utc::now() + chrono::Duration::days(2);
    sweep_now(&pool, later).await.unwrap();
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM oauth_clients").fetch_all(&pool).await.unwrap();
    assert_eq!(ids, vec![used.clone()]);
    // Its access token expired more than a day before; the refresh token lives on.
    let kinds: Vec<String> = sqlx::query_scalar("SELECT kind FROM oauth_tokens ORDER BY kind").fetch_all(&pool).await.unwrap();
    assert_eq!(kinds, vec!["refresh".to_string()]);
    let _ = unused;
    // Sixty days on, everything has lapsed: the grant and then the client go.
    let much_later = chrono::Utc::now() + chrono::Duration::days(60);
    sweep_now(&pool, much_later).await.unwrap();
    let left: (i64, i64, i64) = sqlx::query_as("SELECT (SELECT COUNT(*) FROM oauth_clients), (SELECT COUNT(*) FROM oauth_grants), (SELECT COUNT(*) FROM oauth_tokens)")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, (0, 0, 0));
}

#[tokio::test]
async fn registration_is_rate_limited_per_address() {
    let (app, _) = oauth_app().await;
    let body = json!({"redirect_uris": [LOOPBACK], "token_endpoint_auth_method": "none"});
    let mut last = StatusCode::CREATED;
    for _ in 0..31 {
        last = register(&app, body.clone()).await.0;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn an_account_has_at_most_twenty_connected_apps() {
    let (app, pool) = oauth_app().await;
    let (id, session) = user(&pool, "bryan@example.com").await;
    let mut clients = Vec::new();
    for _ in 0..20 {
        let c = public_client(&app, LOOPBACK).await;
        sqlx::query("INSERT INTO oauth_grants (id, user_id, client_id, scope, resource, redirect_uri, created_at) VALUES (?, ?, ?, 'mcp', ?, ?, '2026-10-22T00:00:00Z')")
            .bind(crate::util::new_id())
            .bind(&id)
            .bind(&c)
            .bind(format!("{BASE}/mcp"))
            .bind(LOOPBACK)
            .execute(&pool)
            .await
            .unwrap();
        clients.push(c);
    }
    let one_more = public_client(&app, LOOPBACK).await;
    let (status, r) = decide(&app, &session, &authorize_params(&one_more, LOOPBACK, VERIFIER), true).await;
    assert_eq!(status, StatusCode::CONFLICT, "{r}");
    // Signing in again with an app already connected replaces it, so that still works.
    let (status, r) = decide(&app, &session, &authorize_params(&clients[0], LOOPBACK, VERIFIER), true).await;
    assert_eq!(status, StatusCode::OK, "{r}");
}
