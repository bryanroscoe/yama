//! Open sign-up, the Google token checks, disabled accounts, password sign-in and the sign-in
//! limits, all through the whole router (`testutil`), signed with a test key.

use crate::auth::JwkCache;
use crate::config::Config;
use crate::limits::Cidr;
use crate::testutil::{config, send, state_with};
use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use tower::ServiceExt;

const CLIENT: &str = "test-client.apps.googleusercontent.com";
const KID: &str = "test-key";
/// A throwaway 2048-bit RSA key made for these tests (`openssl genrsa -traditional 2048`). It
/// signs nothing anywhere else; `TEST_N` and `TEST_E` are its public half as a JWK.
const TEST_KEY: &str = "-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEAyHt89dnuZQCgjdJQ19I1tE56K38zzfNvSIsPgNnPs/GTU4+R\nip6N6uk+iYx8b8ViKsNyjNMOAOkbFEx559ovRZKh9XJXYm0h9pHafl/zC0KUmXpy\nCxUkUkSFNuFwlMWrr2nMjzE8dW7i0mVXMUItz8a5cAQ29HF3P+zeHWW8IW4Zktk2\ntBWrCUJrNT9ACFFHi7yevnzM35wu6YtLQKZtqppHEPovclMnmSsZWwkYp2kOhnFv\nLGoh+t2eS6HstwxoA9b2PvbuhI9WeeEXDttc++DRP281md4bcfcKMUaFkp2JM6mz\nzZgQvW/lIsseg0Ih1/SLOYBIBIYkuVFBJDMD3QIDAQABAoIBAAOFLZLIjpfN7MPI\nvVwoyAIgPaNtYpy7aUkSDgXibTP46jAVrYXMVmwZR9yU76trwRdEosqHuy93aF8R\nH7PbQCi91COx7Ahhp67DbV16NFOOifru7Dk3GBHsu5UU3Mvz85mLJ0kdYXUjaw6s\nMl1+Tr0e/WsS298rbd9cuqK0Alto4kvc6EwQ7yVHE5jTTR0GMVddrF2YLLzNJS0d\neeW5U4AhkC9BPszFDlSvq1FP/7Yx00nmwd4/q+iXTwwLW66ijuIWdQVPlpk+gyNR\nuSnvKFCncelQAEyd76vvz9ZSJz5inNz4dTEkL1hSZunMZT+W//Xyi/XqRmpJeWkY\n1T0i48kCgYEA4pVP5lwqJmG0leq0nMuFQXH6BPVvWOao3nb8HL+HWynjGdfr5pI1\nOWBVZgJPIYs1Au5fm9j7LAosjfZbGXWOL0gQ3M8DjTdcRk/OLoMA1GzWEDERjwwM\n9rhIiejToKvU5/W71KSQFoqgutKvaUz+3bNtZ36KVvGC6eRN1vCrf5kCgYEA4oKw\n7rATSsRQS1R2vaNlVMi5e9ws6dPvtEaWvh2hYtJYcrpEYwL26+NMKV4bO2tH52Sr\nmV9wCbyWOekuMU3JTI5QyAL5ktZEm738xutUjg0Qvv8lgmCavhYssDHCd1RhBI2q\npsyf+ofYvAmhOzGlo7PZMYgTSf2DjCBuESrE4OUCgYBWduYLoSYQiX5xKySLJPsP\n81+WXtaD1Vmhs0QX8FrFxiE8rnH+BdM7tvA/wifSRB4RpUdk4JNQxf0km1s+Rubg\nUh7lNDZFwFd9GV0z0JgTeAjkGuV5cf7Mc5xyzB9eE9RmRBbOWZIGmBYn1NhNVa14\nisz4DojaDsWHXbD6kdLQGQKBgF0vyz7HbYhq72WuYBNwr3WMBtMwJ8IjERCnocih\nRA3137GDdDMPuyocnu696pItdq15uyckHmHDFkLI7doW2GQIgK9omeiRAjTYmq/z\njRvLwEHzkijrOX5OfSAXuJuDOU64QabRtFdLoBzsEUrbB/wrN4WrJ9Re2cnCZcXm\nRI0JAoGAAmTJZoHnS1UkMXiL/Lsk6Bf7eehHn4rO52acsTuHYrK1WIqZB0bvJLYw\nctstqMc6AZKF1m2w4gsHCbfubc1IgHKILmm1X/PW8Sl6SI62n6Yqi6B9t/WMKjsz\n84eDhpCvZh7PW+d2i2lwZWgad4Qd3m9cOfOWMkr5/EzkVzTKX4I=\n-----END RSA PRIVATE KEY-----";
const TEST_N: &str = "yHt89dnuZQCgjdJQ19I1tE56K38zzfNvSIsPgNnPs_GTU4-Rip6N6uk-iYx8b8ViKsNyjNMOAOkbFEx559ovRZKh9XJXYm0h9pHafl_zC0KUmXpyCxUkUkSFNuFwlMWrr2nMjzE8dW7i0mVXMUItz8a5cAQ29HF3P-zeHWW8IW4Zktk2tBWrCUJrNT9ACFFHi7yevnzM35wu6YtLQKZtqppHEPovclMnmSsZWwkYp2kOhnFvLGoh-t2eS6HstwxoA9b2PvbuhI9WeeEXDttc--DRP281md4bcfcKMUaFkp2JM6mzzZgQvW_lIsseg0Ih1_SLOYBIBIYkuVFBJDMD3Q";
const TEST_E: &str = "AQAB";

/// A server with Google sign-in on a fresh database, the test key as Google's, and `tweak`ed settings.
async fn server(tweak: impl FnOnce(&mut Config)) -> (Router, SqlitePool) {
    let pool = crate::db::test_pool().await;
    (server_on(&pool, tweak).await, pool)
}

/// The same on an existing database: a server restarted with other settings.
async fn server_on(pool: &SqlitePool, tweak: impl FnOnce(&mut Config)) -> Router {
    let mut cfg = config();
    cfg.google_client_ids = vec![CLIENT.into()];
    cfg.admin_emails = vec!["admin@example.com".into()];
    tweak(&mut cfg);
    let mut st = state_with(cfg, pool.clone()).await;
    st.google_keys = Arc::new(JwkCache::fixed(&[(KID, TEST_N, TEST_E)]));
    crate::routes::app(st)
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// The claims of a good Google ID token for `sub` and `email`.
fn claims(sub: &str, email: &str) -> Value {
    json!({
        "iss": "https://accounts.google.com",
        "aud": CLIENT,
        "sub": sub,
        "email": email,
        "email_verified": true,
        "name": "Test Person",
        "iat": now(),
        "exp": now() + 3600,
    })
}

fn sign(claims: &Value) -> String {
    let mut h = Header::new(Algorithm::RS256);
    h.kid = Some(KID.into());
    jsonwebtoken::encode(&h, claims, &EncodingKey::from_rsa_pem(TEST_KEY.as_bytes()).unwrap()).unwrap()
}

fn google(sub: &str, email: &str) -> String {
    sign(&claims(sub, email))
}

static NEXT_ADDRESS: AtomicU32 = AtomicU32::new(1);

/// A peer address no other request in these tests uses, so per-address limits stay out of the way.
fn fresh_address() -> String {
    let n = NEXT_ADDRESS.fetch_add(1, Ordering::Relaxed);
    format!("10.{}.{}.{}", (n >> 16) & 255, (n >> 8) & 255, n & 255)
}

/// POST JSON from peer `from`, optionally with `CF-Connecting-IP`.
async fn post_from(app: &Router, path: &str, body: Value, from: &str, cf: Option<&str>) -> (StatusCode, Value, HeaderMap) {
    let mut req = Request::builder().method(Method::POST).uri(path).header(header::CONTENT_TYPE, "application/json");
    if let Some(cf) = cf {
        req = req.header("cf-connecting-ip", cf);
    }
    let mut req = req.body(Body::from(body.to_string())).unwrap();
    req.extensions_mut().insert(ConnectInfo(SocketAddr::new(from.parse().unwrap(), 40000)));
    let res = app.clone().oneshot(req).await.unwrap();
    let (status, headers) = (res.status(), res.headers().clone());
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null), headers)
}

/// Google sign-in with `credential` from a fresh address: (status, body).
async fn sign_in(app: &Router, credential: &str) -> (StatusCode, Value) {
    let (status, body, _) = post_from(app, "/api/auth/google", json!({ "credential": credential }), &fresh_address(), None).await;
    (status, body)
}

/// Sign in and return the session token, failing the test if refused.
async fn signed_in(app: &Router, sub: &str, email: &str) -> (String, Value) {
    let (status, body) = sign_in(app, &google(sub, email)).await;
    assert_eq!(status, StatusCode::OK, "{email}: {body}");
    (body["token"].as_str().unwrap().to_string(), body["user"].clone())
}

async fn password(app: &Router, email: &str, password: &str) -> (StatusCode, Value) {
    let (status, body, _) = post_from(app, "/api/auth/password", json!({ "email": email, "password": password }), &fresh_address(), None).await;
    (status, body)
}

async fn users(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn invite_only_is_the_default() {
    let (app, pool) = server(|_| {}).await;
    let (status, body) = sign_in(&app, &google("g-stranger", "stranger@gmail.com")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "stranger@gmail.com hasn't been invited to Yama yet");
    assert_eq!(users(&pool).await, 0, "a refused sign-in makes no account");

    crate::auth::add_invite(&pool, "Friend@Gmail.com", None).await.unwrap();
    let (_, user) = signed_in(&app, "g-friend", "friend@gmail.com").await;
    assert_eq!((user["is_admin"].as_bool(), user["limited"].as_bool()), (Some(false), Some(false)));
    // The email in the token is matched however it's capitalised.
    signed_in(&app, "g-friend", "FRIEND@gmail.com").await;
    let (_, admin) = signed_in(&app, "g-admin", "admin@example.com").await;
    assert_eq!(admin["is_admin"], true);
    assert_eq!(users(&pool).await, 2);
}

#[tokio::test]
async fn open_signup_lets_any_verified_google_account_in_with_the_smaller_allowance() {
    let (app, pool) = server(|c| c.open_signup = true).await;
    let (token, user) = signed_in(&app, "g-stranger", "Stranger@Gmail.com").await;
    assert_eq!(user["email"], "stranger@gmail.com");
    assert_eq!(user["limited"], true);
    let (status, me) = send(&app, Method::GET, "/api/me", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((me["limited"].as_bool(), me["is_admin"].as_bool()), (Some(true), Some(false)));
    // Signing in again is the same account.
    signed_in(&app, "g-stranger", "stranger@gmail.com").await;
    assert_eq!(users(&pool).await, 1);

    // An invite gives the full allowance at once, without signing in again.
    crate::auth::add_invite(&pool, "stranger@gmail.com", None).await.unwrap();
    let (_, me) = send(&app, Method::GET, "/api/me", Some(&token), None).await;
    assert_eq!(me["limited"], false);
    // Admins and invited people are never limited.
    let (_, admin) = signed_in(&app, "g-admin", "admin@example.com").await;
    assert_eq!((admin["is_admin"].as_bool(), admin["limited"].as_bool()), (Some(true), Some(false)));
    // A long Google name is cut down.
    let mut c = claims("g-long", "long@gmail.com");
    c["name"] = json!("x".repeat(500));
    let (status, body) = sign_in(&app, &sign(&c)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["user"]["display_name"].as_str().unwrap().len(), 60);
}

#[tokio::test]
async fn google_tokens_are_checked_carefully() {
    let (app, pool) = server(|c| c.open_signup = true).await;
    let refused = |what: &'static str, c: Value| (what, sign(&c));
    let mut cases = Vec::new();
    let mut c = claims("g1", "a@gmail.com");
    c["aud"] = json!("someone-elses-client.apps.googleusercontent.com");
    cases.push(refused("another app's audience", c));
    let mut c = claims("g1", "a@gmail.com");
    c["aud"] = json!(["someone-elses-client", "another"]);
    cases.push(refused("a list of other audiences", c));
    let mut c = claims("g1", "a@gmail.com");
    c.as_object_mut().unwrap().remove("aud");
    cases.push(refused("no audience", c));
    let mut c = claims("g1", "a@gmail.com");
    c["iss"] = json!("https://evil.example");
    cases.push(refused("another issuer", c));
    let mut c = claims("g1", "a@gmail.com");
    c.as_object_mut().unwrap().remove("iss");
    cases.push(refused("no issuer", c));
    let mut c = claims("g1", "a@gmail.com");
    c["exp"] = json!(now() - 3600);
    cases.push(refused("expired an hour ago", c));
    let mut c = claims("g1", "a@gmail.com");
    c.as_object_mut().unwrap().remove("exp");
    cases.push(refused("no expiry", c));
    let mut c = claims("g1", "a@gmail.com");
    c.as_object_mut().unwrap().remove("sub");
    cases.push(refused("no subject", c));
    let mut c = claims("g1", "a@gmail.com");
    c["email_verified"] = json!(false);
    cases.push(refused("email not verified", c));
    let mut c = claims("g1", "a@gmail.com");
    c.as_object_mut().unwrap().remove("email_verified");
    cases.push(refused("email_verified missing", c));
    let mut c = claims("g1", "a@gmail.com");
    c["email_verified"] = json!("false");
    cases.push(refused("email_verified \"false\"", c));
    let mut c = claims("g1", "a@gmail.com");
    c.as_object_mut().unwrap().remove("email");
    cases.push(refused("no email", c));
    // HS256 "signed" with the public key, the classic algorithm mix-up.
    let mut h = Header::new(Algorithm::HS256);
    h.kid = Some(KID.into());
    cases.push(("HS256 with the public key as secret", jsonwebtoken::encode(&h, &claims("g1", "a@gmail.com"), &EncodingKey::from_secret(TEST_N.as_bytes())).unwrap()));
    // A real token with its claims swapped for another token's after signing.
    let good = google("g1", "a@gmail.com");
    let other = google("g1", "admin@example.com");
    let (parts, theirs): (Vec<&str>, Vec<&str>) = (good.split('.').collect(), other.split('.').collect());
    cases.push(("claims changed after signing", format!("{}.{}.{}", parts[0], theirs[1], parts[2])));
    for (what, token) in &cases {
        let (status, body) = sign_in(&app, token).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{what}: {body}");
    }
    // Garbage and unknown keys are a 400.
    let mut h = Header::new(Algorithm::RS256);
    h.kid = Some("not-a-google-key".into());
    let unknown = jsonwebtoken::encode(&h, &claims("g1", "a@gmail.com"), &EncodingKey::from_rsa_pem(TEST_KEY.as_bytes()).unwrap()).unwrap();
    for (what, token) in [("garbage", "not.a.token".to_string()), ("unknown key id", unknown)] {
        let (status, body) = sign_in(&app, &token).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{what}: {body}");
    }
    assert_eq!(users(&pool).await, 0, "nothing refused made an account");

    // The good one, and the older string form of email_verified, work.
    signed_in(&app, "g1", "a@gmail.com").await;
    let mut c = claims("g2", "b@gmail.com");
    c["email_verified"] = json!("true");
    let (status, _) = sign_in(&app, &sign(&c)).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn an_account_stays_tied_to_its_google_account() {
    let (app, pool) = server(|c| c.open_signup = true).await;
    let (_, first) = signed_in(&app, "g-original", "pat@example.org").await;
    // Another Google account with the same address (a recreated non-Gmail account, say) is refused.
    let (status, body) = sign_in(&app, &google("g-imposter", "pat@example.org")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body["error"].as_str().unwrap().contains("different Google account"), "{body}");
    // The same Google account under a new address is still the same Yama account.
    let (_, moved) = signed_in(&app, "g-original", "pat@new.example.org").await;
    assert_eq!(moved["id"], first["id"]);
    assert_eq!(users(&pool).await, 1);
}

#[tokio::test]
async fn open_signup_never_takes_over_an_account_made_another_way() {
    let (app, pool) = server(|c| c.open_signup = true).await;
    crate::auth::add_local_user(&pool, "tester@example.com", None, false, Some("a long enough password".into())).await.unwrap();
    let (status, body) = sign_in(&app, &google("g-tester", "tester@example.com")).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(body["error"].as_str().unwrap().contains("signs in another way"), "{body}");
    let linked: Option<String> = sqlx::query_scalar("SELECT google_sub FROM users WHERE email = 'tester@example.com'").fetch_one(&pool).await.unwrap();
    assert_eq!(linked, None);
    // An invite links Google to it, as before open sign-up.
    crate::auth::add_invite(&pool, "tester@example.com", None).await.unwrap();
    let (_, user) = signed_in(&app, "g-tester", "tester@example.com").await;
    assert_eq!(user["limited"], false);
    assert_eq!(users(&pool).await, 1);
}

#[tokio::test]
async fn turning_open_signup_off_shuts_out_accounts_without_an_invite() {
    let pool = crate::db::test_pool().await;
    let open = server_on(&pool, |c| c.open_signup = true).await;
    let closed = server_on(&pool, |_| {}).await;
    let (stranger, _) = signed_in(&open, "g-stranger", "stranger@gmail.com").await;
    crate::auth::add_invite(&pool, "friend@gmail.com", None).await.unwrap();
    let (friend, _) = signed_in(&open, "g-friend", "friend@gmail.com").await;
    let (status, key) = send(&open, Method::POST, "/api/me/tokens", Some(&stranger), Some(json!({ "name": "laptop" }))).await;
    assert_eq!(status, StatusCode::OK);
    let key = key["token"].as_str().unwrap().to_string();
    assert_eq!(send(&open, Method::GET, "/api/plan/head", Some(&key), None).await.0, StatusCode::OK);

    // With open sign-up off, the stranger's session, script key and Google sign-in all stop working.
    assert_eq!(send(&closed, Method::GET, "/api/me", Some(&stranger), None).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&closed, Method::GET, "/api/plan/head", Some(&key), None).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(sign_in(&closed, &google("g-stranger", "stranger@gmail.com")).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&closed, Method::GET, "/api/me", Some(&friend), None).await.0, StatusCode::OK);
    // An invite lets them back in.
    crate::auth::add_invite(&pool, "stranger@gmail.com", None).await.unwrap();
    assert_eq!(send(&closed, Method::GET, "/api/me", Some(&stranger), None).await.0, StatusCode::OK);
}

#[tokio::test]
async fn disabled_accounts_are_signed_out_and_every_way_in_refuses_them() {
    let (app, pool) = server(|c| c.open_signup = true).await;
    let (token, _) = signed_in(&app, "g-pat", "pat@gmail.com").await;
    let (_, key) = send(&app, Method::POST, "/api/me/tokens", Some(&token), Some(json!({ "name": "laptop" }))).await;
    let key = key["token"].as_str().unwrap().to_string();
    crate::auth::add_local_user(&pool, "debug@example.com", None, false, Some("a long enough password".into())).await.unwrap();

    assert!(crate::auth::set_disabled_by_email(&pool, "Pat@Gmail.com", true).await.unwrap());
    assert!(crate::auth::set_disabled_by_email(&pool, "debug@example.com", true).await.unwrap());
    assert!(!crate::auth::set_disabled_by_email(&pool, "nobody@example.com", true).await.unwrap());
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions").fetch_one(&pool).await.unwrap();
    assert_eq!(sessions, 0, "disabling ends every session");
    assert_eq!(send(&app, Method::GET, "/api/me", Some(&token), None).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&app, Method::GET, "/api/plan/head", Some(&key), None).await.0, StatusCode::UNAUTHORIZED);
    let (status, body) = sign_in(&app, &google("g-pat", "pat@gmail.com")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], crate::auth::DISABLED);
    let (status, body) = password(&app, "debug@example.com", "a long enough password").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], crate::auth::DISABLED);
    // The password form isn't offered for a disabled account alone.
    let (_, cfg) = send(&app, Method::GET, "/api/auth/config", None, None).await;
    assert_eq!(cfg["password_login"], false);

    // Enabled again: sign-in works, and the old script key works again.
    assert!(crate::auth::set_disabled_by_email(&pool, "pat@gmail.com", false).await.unwrap());
    signed_in(&app, "g-pat", "pat@gmail.com").await;
    assert_eq!(send(&app, Method::GET, "/api/plan/head", Some(&key), None).await.0, StatusCode::OK);
}

#[tokio::test]
async fn admins_list_accounts_and_turn_them_off_in_the_app() {
    let (app, pool) = server(|c| c.open_signup = true).await;
    let (admin, admin_user) = signed_in(&app, "g-admin", "admin@example.com").await;
    let (stranger, stranger_user) = signed_in(&app, "g-stranger", "stranger@gmail.com").await;
    crate::auth::add_local_user(&pool, "other-admin@example.com", None, true, Some("a long enough password".into())).await.unwrap();

    assert_eq!(send(&app, Method::GET, "/api/admin/users", Some(&stranger), None).await.0, StatusCode::NOT_FOUND);
    let path = |id: &Value, what: &str| format!("/api/admin/users/{}/{what}", id.as_str().unwrap());
    assert_eq!(send(&app, Method::POST, &path(&admin_user["id"], "disable"), Some(&stranger), None).await.0, StatusCode::NOT_FOUND);

    let (status, list) = send(&app, Method::GET, "/api/admin/users", Some(&admin), None).await;
    assert_eq!(status, StatusCode::OK);
    let row = list.as_array().unwrap().iter().find(|u| u["email"] == "stranger@gmail.com").unwrap().clone();
    assert_eq!((row["limited"].as_bool(), row["invited"].as_bool(), row["google"].as_bool()), (Some(true), Some(false), Some(true)));
    assert!(row["last_sign_in"].is_string() && row["disabled_at"].is_null());

    assert_eq!(send(&app, Method::POST, &path(&stranger_user["id"], "disable"), Some(&admin), None).await.0, StatusCode::OK);
    assert_eq!(send(&app, Method::GET, "/api/me", Some(&stranger), None).await.0, StatusCode::UNAUTHORIZED);
    let (_, list) = send(&app, Method::GET, "/api/admin/users", Some(&admin), None).await;
    assert!(list.as_array().unwrap().iter().any(|u| u["email"] == "stranger@gmail.com" && u["disabled_at"].is_string()));
    // Not yourself, and not another admin (that's for the command line).
    assert_eq!(send(&app, Method::POST, &path(&admin_user["id"], "disable"), Some(&admin), None).await.0, StatusCode::BAD_REQUEST);
    let other: String = sqlx::query_scalar("SELECT id FROM users WHERE email = 'other-admin@example.com'").fetch_one(&pool).await.unwrap();
    assert_eq!(send(&app, Method::POST, &path(&json!(other), "disable"), Some(&admin), None).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&app, Method::POST, &path(&json!("no-such-id"), "disable"), Some(&admin), None).await.0, StatusCode::NOT_FOUND);

    assert_eq!(send(&app, Method::POST, &path(&stranger_user["id"], "enable"), Some(&admin), None).await.0, StatusCode::OK);
    signed_in(&app, "g-stranger", "stranger@gmail.com").await;
    assert_eq!(send(&app, Method::POST, &path(&json!("no-such-id"), "enable"), Some(&admin), None).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn password_sign_in_never_makes_an_account_and_can_be_turned_off() {
    let (app, pool) = server(|c| c.open_signup = true).await;
    // An email with no account is refused like a wrong password, and nothing is made.
    let (status, body) = password(&app, "new-person@example.com", "a long enough password").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "wrong email or password");
    assert_eq!(users(&pool).await, 0);
    // There's no sign-up route of any kind.
    for path in ["/api/auth/signup", "/api/auth/register", "/api/users", "/api/auth/password/set", "/api/me/password"] {
        let body = json!({ "email": "new-person@example.com", "password": "a long enough password" });
        let (status, _) = send(&app, Method::POST, path, None, Some(body)).await;
        assert!(status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED, "{path}: {status}");
    }
    // A Google sign-in never gives an account a password.
    signed_in(&app, "g-pat", "pat@gmail.com").await;
    let with_password: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE password_hash IS NOT NULL").fetch_one(&pool).await.unwrap();
    assert_eq!(with_password, 0);
    assert_eq!(send(&app, Method::GET, "/api/auth/config", None, None).await.1["password_login"], false);

    // An account from `yama-server user add` signs in...
    crate::auth::add_local_user(&pool, "debug@example.com", None, false, Some("a long enough password".into())).await.unwrap();
    assert_eq!(send(&app, Method::GET, "/api/auth/config", None, None).await.1["password_login"], true);
    let (status, body) = password(&app, "debug@example.com", "a long enough password").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["user"]["limited"], false, "a password account is the host's own");
    // ...until YAMA_PASSWORD_LOGIN=0.
    let off = server_on(&pool, |c| c.password_login = false).await;
    let (status, body) = password(&off, "debug@example.com", "a long enough password").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "password sign-in is turned off on this server");
    assert_eq!(send(&off, Method::GET, "/api/auth/config", None, None).await.1["password_login"], false);
}

/// Only the command line makes password accounts: `add_local_user` is called from `main.rs`
/// alone, and no other source file touches `password_hash`.
#[test]
fn only_the_command_line_sets_passwords() {
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    walk(&src, &mut files);
    assert!(files.len() > 20);
    for f in files {
        let name = f.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
        if name.contains("tests") || name == "testutil.rs" {
            continue;
        }
        let text = std::fs::read_to_string(&f).unwrap();
        if text.contains("add_local_user(") {
            assert!(name == "auth.rs" || name == "main.rs", "{name} calls add_local_user");
        }
        if text.contains("password_hash") {
            assert_eq!(name, "auth.rs", "{name} touches password_hash");
        }
    }
}

#[tokio::test]
async fn sign_in_is_rate_limited_per_address_and_per_email() {
    let (app, pool) = server(|c| {
        c.open_signup = true;
        c.trusted_proxies = vec![Cidr::parse("172.18.0.0/16").unwrap()];
    })
    .await;
    let garbage = json!({ "credential": "not.a.token" });
    // Ten tries from one address, then a 429 that says how long to wait.
    for _ in 0..10 {
        assert_eq!(post_from(&app, "/api/auth/google", garbage.clone(), "203.0.113.1", None).await.0, StatusCode::BAD_REQUEST);
    }
    let (status, body, headers) = post_from(&app, "/api/auth/google", garbage.clone(), "203.0.113.1", None).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"], "Too many sign-in attempts from this address. Try again in 10 minutes.");
    assert!(headers[header::RETRY_AFTER].to_str().unwrap().parse::<u64>().unwrap() > 500);
    // The password form shares the count, and turns the address away before checking anything.
    let (status, _, _) = post_from(&app, "/api/auth/password", json!({ "email": "x@example.com", "password": "x" }), "203.0.113.1", None).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    // A CF-Connecting-IP header from a peer outside YAMA_TRUSTED_PROXIES changes nothing.
    let (status, _, _) = post_from(&app, "/api/auth/google", garbage.clone(), "203.0.113.1", Some("198.51.100.1")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    // Another address has its own count.
    assert_eq!(post_from(&app, "/api/auth/google", garbage.clone(), "203.0.113.2", None).await.0, StatusCode::BAD_REQUEST);

    // Through the tunnel (a trusted peer) each visitor's CF-Connecting-IP counts on its own.
    for _ in 0..10 {
        assert_eq!(post_from(&app, "/api/auth/google", garbage.clone(), "172.18.0.5", Some("198.51.100.7")).await.0, StatusCode::BAD_REQUEST);
    }
    assert_eq!(post_from(&app, "/api/auth/google", garbage.clone(), "172.18.0.5", Some("198.51.100.7")).await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(post_from(&app, "/api/auth/google", garbage.clone(), "172.18.0.5", Some("198.51.100.8")).await.0, StatusCode::BAD_REQUEST);

    // Per email: ten sign-ins from ten addresses, then the email waits, password form included.
    for _ in 0..10 {
        signed_in(&app, "g-pat", "pat@gmail.com").await;
    }
    let (status, body) = sign_in(&app, &google("g-pat", "pat@gmail.com")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(body["error"].as_str().unwrap().starts_with("Too many sign-in attempts for this email"), "{body}");
    crate::auth::add_local_user(&pool, "pat@gmail.com", None, false, Some("a long enough password".into())).await.unwrap();
    assert_eq!(password(&app, "PAT@gmail.com", "a long enough password").await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(password(&app, "pat@gmail.com", "a long enough password").await.0, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn the_sign_in_page_hears_whether_sign_up_is_open() {
    let pool = crate::db::test_pool().await;
    let config = |app: Router| async move { send(&app, Method::GET, "/api/auth/config", None, None).await.1 };
    assert_eq!(config(server_on(&pool, |_| {}).await).await["open_signup"], false);
    assert_eq!(config(server_on(&pool, |c| c.open_signup = true).await).await["open_signup"], true);
    // Without Google sign-in nobody could sign up, so it isn't offered.
    let no_google = server_on(&pool, |c| {
        c.open_signup = true;
        c.google_client_ids.clear();
    })
    .await;
    assert_eq!(config(no_google).await["open_signup"], false);
}
